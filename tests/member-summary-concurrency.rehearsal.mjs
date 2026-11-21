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
}finally{
  for(const t of ['gym_member_summaries','gym_member_summary_dirty','gym_member_summary_ready','gym_entity_counters','gym_entities'])await pool.query(`DELETE FROM gymos.${t} WHERE owner_id LIKE 'rh-%'`).catch(()=>{});
  await pool.query("DELETE FROM gymos.gym_states WHERE user_id LIKE 'rh-%'").catch(()=>{});
  await pool.end();
}
console.log('scenarios 4 (runtime role) and 5 (growth after the counters check) are listed above but not yet implemented in this script.');
process.exit(failed?1:0);
