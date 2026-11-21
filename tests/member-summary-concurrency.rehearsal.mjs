// REHEARSAL SCRIPT, NOT RUN BY THE SUITE. Needs a DISPOSABLE real Postgres database that someone with authority has prepared with the repo's migrations
// applied (through 20261121180000). It refuses to run unless REHEARSAL_DATABASE_URL names a database whose name starts with "rehearsal_".
// It never touches any other database, creates only owners prefixed "rh-", and removes them at the end. Run:
//   REHEARSAL_DATABASE_URL=postgres://.../rehearsal_x node --experimental-strip-types tests/member-summary-concurrency.rehearsal.mjs
// Scenarios (each prints PASS/FAIL, nonzero exit on any FAIL):
//  1. a writer commits a visit between the refresher's mark read and mark clear: the member must end dirty OR its stored inputs must include that visit.
//  2. two refreshers at once: exactly one proceeds, the other reports 'busy' (try-lock), and neither leaves a stale row with a cleared mark.
//  3. refresher under REPEATABLE READ while a writer updates the same summary row: 'busy' (40001), transaction usable after ROLLBACK TO SAVEPOINT, lock_timeout restored.
//  4. runtime role (SET ROLE gymos_app + app.gym_owner): reads, the summary upsert and the dirty delete succeed for its own owner and fail for another owner.
//  5. growth after the counters check (writer inserts rows between the check and the history read): 'raced' under READ COMMITTED; none under withSnapshotScope.
import {registerHooks} from 'node:module';
import pg from 'pg';
const url=process.env.REHEARSAL_DATABASE_URL??'';
const name=url.split('/').pop()?.split('?')[0]??'';
if(!/^rehearsal_/.test(name)){console.error('refusing: REHEARSAL_DATABASE_URL must name a database starting with "rehearsal_"');process.exit(2);}
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},load(u,x,n){if(u.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:'export const getPool=()=>globalThis.__rhPool;export const isFirebaseConfigured=()=>false;'};return n(u,x);}});
const pool=globalThis.__rhPool=new pg.Pool({connectionString:url,max:6});
const {readMemberCandidates,refreshDirtySummaries}=await import('../app/lib/member-summary-store.ts');
const {withSnapshotScope}=await import('../app/lib/member-summary-scope.ts');
let failed=0;const check=(label,ok,extra='')=>{console.log(ok?'PASS':'FAIL',label,extra);if(!ok)failed++;};
const owner='rh-'+Date.now();
const q=(c,s,v)=>c.query(s,v);
async function seed(o){
  await pool.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,'{\"_entityStorage\":1}',1,'x')",[o]);
  await pool.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'members','m1',1,'a','{\"id\":\"m1\",\"branch\":\"a\",\"joined\":\"2026-01-01\",\"expires\":\"2026-12-31\"}')",[o]);
}
const visit=(o,id)=>pool.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'visits',$2,$3,'a',$4)",[o,id,Date.now()%1e6,JSON.stringify({id,member:'m1',branch:'a',day:'2026-03-02',at:'2026-03-02T10:00:00.000Z',leftAt:'2026-03-02T11:00:00.000Z'})]);
const scoped=async(o,work)=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}};
try{
  // 1
  await seed(owner);
  let fired=false;
  const r1=await scoped(owner,c=>readMemberCandidates({query:async(s,v)=>{const r=await c.query(s,v);if(!fired&&/FROM gymos.gym_member_summary_dirty/.test(s)&&/gen/.test(s)){fired=true;await visit(owner,'v-race');}return r;}},owner,null,{refresh:true}));
  const dirty=(await pool.query('SELECT count(*)::int n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1',[owner])).rows[0].n;
  const st=(await pool.query("SELECT stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id='m1'",[owner])).rows[0]?.stored;
  check('1 writer between mark read and clear',dirty===1||(st&&st.visitCount===1),`status=${r1.status} dirty=${dirty} visitCount=${st?.visitCount}`);
  // 2
  await pool.query('SELECT gymos.backfill_member_summaries($1)',[owner]);
  const holder=await pool.connect();await holder.query('BEGIN');await holder.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);await holder.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))',[`msum:${owner}`]);
  const second=await scoped(owner,c=>refreshDirtySummaries(c,owner));
  await holder.query('ROLLBACK');holder.release();
  check('2 second refresher is busy while the first holds the lock',second.status==='busy',`status=${second.status}`);
  // 3
  await pool.query('SELECT gymos.backfill_member_summaries($1)',[owner]);
  const lt0=(await pool.query('SHOW lock_timeout')).rows[0].lock_timeout;
  const w=await pool.connect();await w.query('BEGIN');await w.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);
  const r3p=withSnapshotScope(owner,async c=>{const x=await refreshDirtySummaries(c,owner);const ok=(await c.query('SELECT 1 AS one')).rows[0].one===1;return{x,ok};});
  await new Promise(r=>setTimeout(r,50));await w.query("INSERT INTO gymos.gym_member_summaries(owner_id,member_id,stored) VALUES($1,'m1','{}') ON CONFLICT(owner_id,member_id) DO UPDATE SET stored='{}'",[owner]);await w.query('COMMIT');w.release();
  const r3=await r3p;check('3 snapshot refresher vs same-row writer',['ok','busy'].includes(r3.x.status)&&r3.ok,`status=${r3.x.status} usable=${r3.ok} (busy expected when the writer commits first; both are acceptable, a stale row is not)`);
  const after=(await pool.query("SELECT stored,(SELECT count(*)::int FROM gymos.gym_member_summary_dirty d WHERE d.owner_id=$1) AS dirty FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id='m1'",[owner])).rows[0];
  check('3b no stale row with a cleared mark',!after||after.dirty>0||after.stored.visitCount!==undefined,JSON.stringify(after).slice(0,120));
  check('3c lock_timeout not leaked',(await pool.query('SHOW lock_timeout')).rows[0].lock_timeout===lt0);
  // 4 runtime role: own owner works, other owner sees/changes nothing
  const other=owner+'-x';await seed(other);await pool.query('SELECT gymos.backfill_member_summaries($1)',[owner]);await pool.query('SELECT gymos.backfill_member_summaries($1)',[other]);
  const asRole=async(o,work)=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE gymos_app');await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK').catch(()=>{});return{error:e.code||String(e)};}finally{c.release();}};
  const own=await asRole(owner,c=>refreshDirtySummaries(c,owner));
  check('4a runtime role refreshes its own owner',own.status==='ok',`status=${own.status} error=${own.error??''}`);
  const cross=await asRole(owner,async c=>({d:(await c.query('SELECT count(*)::int n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1',[other])).rows[0].n,u:(await c.query("DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=$1",[other])).rowCount}));
  check('4b runtime role sees and deletes nothing of another owner',cross.d===0&&cross.u===0,JSON.stringify(cross));
  const otherDirty=(await pool.query('SELECT count(*)::int n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1',[other])).rows[0].n;
  check('4c other owner marks untouched',otherDirty===1,`dirty=${otherDirty}`);
  const snap=async()=>JSON.stringify([(await pool.query("SELECT member_id,stored FROM gymos.gym_member_summaries WHERE owner_id=$1 ORDER BY 1",[other])).rows,(await pool.query("SELECT member_id,gen FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 ORDER BY 1",[other])).rows,(await pool.query("SELECT count(*)::int n FROM gymos.gym_member_summary_ready WHERE owner_id=$1",[other])).rows]);
  const before=await snap();
  const denied=async(label,sql,vals)=>{const r=await asRole(owner,c=>c.query(sql,vals));check(label,r.error==='42501'||(r.rowCount===0&&!r.error),JSON.stringify({e:r.error,n:r.rowCount}));};
  await denied('4d forged summary insert for another owner is 42501',"INSERT INTO gymos.gym_member_summaries(owner_id,member_id,stored) VALUES($1,'mx','{}')",[other]);
  await denied('4e conflict-update of another owner row is denied or affects 0 rows',"INSERT INTO gymos.gym_member_summaries(owner_id,member_id,stored) VALUES($1,'m1','{\"forged\":1}') ON CONFLICT(owner_id,member_id) DO UPDATE SET stored=EXCLUDED.stored",[other]);
  await denied('4f plain UPDATE of another owner summary affects 0 rows',"UPDATE gymos.gym_member_summaries SET stored='{\"forged\":1}' WHERE owner_id=$1",[other]);
  await denied('4g runtime role cannot INSERT a dirty mark (table grant is SELECT,DELETE)',"INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) VALUES($1,'m1',1)",[owner]);
  await denied('4h runtime role cannot INSERT a ready marker',"INSERT INTO gymos.gym_member_summary_ready(owner_id) VALUES($1)",[other]);
  check('4i foreign owner rows are byte-identical after every attempt',(await snap())===before);
  // 5 growth between the counters check and the history read
  await pool.query('SELECT gymos.backfill_member_summaries($1)',[owner]);
  const grow=async(c)=>{let fired=false;return{query:async(s,v)=>{const r=await c.query(s,v);if(!fired&&/gym_entity_counters/.test(s)){fired=true;for(let i=0;i<3;i++)await visit(owner,'v-grow'+i+Date.now());}return r;}};};
  const visitsNow=async()=>(await pool.query("SELECT count(*)::int n FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits'",[owner])).rows[0].n;
  const rc=await scoped(owner,async c=>refreshDirtySummaries(await grow(c),owner));
  const rcStored=(await pool.query("SELECT stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id='m1'",[owner])).rows[0]?.stored;
  const rcDirty=(await pool.query("SELECT count(*)::int n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id='m1'",[owner])).rows[0].n;
  const total=await visitsNow();
  check('5a READ COMMITTED growth: raced (nothing stored from partial rows), or stored inputs include ALL visits, or member stays dirty',rc.status==='raced'||(rc.status==='ok'&&rcStored?.visitCount===total)||rcDirty===1,`status=${rc.status} visitCount=${rcStored?.visitCount} actual=${total} dirty=${rcDirty}`);
  await pool.query('SELECT gymos.backfill_member_summaries($1)',[owner]);
  const preStored=JSON.stringify((await pool.query("SELECT stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id='m1'",[owner])).rows[0]?.stored??null);
  const sn=await withSnapshotScope(owner,async c=>refreshDirtySummaries(await grow(c),owner));
  const snStored=(await pool.query("SELECT stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id='m1'",[owner])).rows[0]?.stored;
  const snDirty=(await pool.query("SELECT count(*)::int n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id='m1'",[owner])).rows[0].n;
  const total2=await visitsNow();
  check('5b snapshot: never raced. busy (40001 from deleting a concurrently re-marked dirty mark) must roll back: stored inputs unchanged and mark present. ok must show a snapshot-consistent count (total minus the 3 later rows) and the newer mark retained',
    sn.status!=='raced'&&((sn.status==='busy'&&JSON.stringify(snStored??null)===preStored&&snDirty===1)||(sn.status==='ok'&&snStored?.visitCount===total2-3&&snDirty===1)),
    `status=${sn.status} visitCount=${snStored?.visitCount} actual=${total2} dirty=${snDirty} unchanged=${JSON.stringify(snStored??null)===preStored} (UNRUN hypothesis)`);
}finally{
  for(const t of ['gym_member_summaries','gym_member_summary_dirty','gym_member_summary_ready','gym_entity_counters','gym_entities'])await pool.query(`DELETE FROM gymos.${t} WHERE owner_id LIKE 'rh-%'`).catch(()=>{});
  await pool.query("DELETE FROM gymos.gym_states WHERE user_id LIKE 'rh-%'").catch(()=>{});
  await pool.end();
}
process.exit(failed?1:0);
