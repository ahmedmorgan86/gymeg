// REHEARSAL SCRIPT 2, NOT RUN BY THE SUITE. Real PostgreSQL in a rehearsal_ database only (same guard as scenarios 1-5). Synthetic owners prefixed "rh2-", removed at the end.
// A. race injection at every refresher statement boundary (marks read / member read / history read / upsert) with a writer that cancels a period AND adds a visit:
//    invariant: after the race either the member is still dirty, or its stored inputs equal a clean forced recompute.
// B. overlapping multi-member writers (same owner, opposite member order, multi-statement transactions): count deadlocks (40P01) and serialization errors.
// C. bulk-write overhead with the counters + summary-mark triggers on vs the user triggers disabled (ratio, one machine, not capacity).
// D. overlapping bounded refreshes over separate connections: same owner (advisory lock) and different owners.
import {registerHooks} from 'node:module';
import pg from 'pg';
const url=process.env.REHEARSAL_DATABASE_URL??'';
let name='';try{name=decodeURIComponent(new URL(url).pathname.replace(/^\//,''));}catch{}
if(!/^rehearsal_/.test(name)){console.error('refusing: REHEARSAL_DATABASE_URL must name a database starting with "rehearsal_"');process.exit(2);}
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},load(u,x,n){if(u.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:'export const getPool=()=>globalThis.__rhPool;export const isFirebaseConfigured=()=>false;'};return n(u,x);}});
const pool=globalThis.__rhPool=new pg.Pool({connectionString:url,max:12});
const {refreshDirtySummaries}=await import('../app/lib/member-summary-store.ts');
let failed=0;const check=(label,ok,extra='')=>{console.log(ok?'PASS':'FAIL',label,extra);if(!ok)failed++;};
const R=Date.now();
const info=(await pool.query("SELECT version() v,current_user u,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su,current_setting('transaction_isolation') iso,current_setting('default_transaction_isolation') diso")).rows[0];
console.log('SERVER',info.v,'| connect role:',info.u,'superuser:',info.su,'| default isolation:',info.diso);
const owners=[];
async function seed(o,n,{visits=0}={}){owners.push(o);
  await pool.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,'{\"_entityStorage\":1}',1,'x')",[o]);
  await pool.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'members','m'||g,g,'a',jsonb_build_object('id','m'||g,'branch','a','joined','2026-01-01','expires','2026-12-31','membershipPeriods',jsonb_build_array(jsonb_build_object('id','p'||g,'plan','pl','start','2026-01-01','end','2026-12-31','visits',null,'cancelled',false))) FROM generate_series(1,$2) g",[o,n]);
  if(visits)await pool.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'visits','v'||g||'_'||d,g*100+d,'a',jsonb_build_object('id','v'||g||'_'||d,'member','m'||g,'branch','a','day','2026-03-0'||d,'at','2026-03-0'||d||'T10:00:00.000Z','leftAt','2026-03-0'||d||'T11:00:00.000Z','periodId','p'||g) FROM generate_series(1,$2) g,generate_series(1,$3) d",[o,n,visits]);
}
const scoped=async(o,work)=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}};
const storedOf=async(o,m)=>JSON.stringify((await pool.query('SELECT stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id=$2',[o,m])).rows[0]?.stored??null);
const dirtyOf=async(o,m)=>(await pool.query('SELECT count(*)::int n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=$2',[o,m])).rows[0].n;
let seq=0;
const writer=async(o)=>{ // cancel the period of m1 and add a visit for m1 (two committed statements)
  await pool.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{membershipPeriods,0,cancelled}','true') WHERE owner_id=$1 AND collection='members' AND entity_id='m1'",[o]);
  await pool.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'visits',$2,$3,'a',$4)",[o,'vr'+(++seq)+'-'+R,900000+seq,JSON.stringify({id:'vr'+seq,member:'m1',branch:'a',day:'2026-03-09',at:'2026-03-09T10:00:00.000Z',leftAt:'2026-03-09T11:00:00.000Z',periodId:'p1'})]);};
try{
  // A
  const points={'marks read':/FROM gymos\.gym_member_summary_dirty/,'member read':/collection='members' AND entity_id=ANY/,'history read':/LATERAL/,'upsert':/INSERT INTO gymos\.gym_member_summaries/,'dirty delete':/DELETE FROM gymos\.gym_member_summary_dirty/};
  for(const [label,re] of Object.entries(points)){for(const when of ['before','after']){
    const o=`rh2-A-${label.replace(/ /g,'')}-${when}-${R}`;await seed(o,3,{visits:2});await pool.query('SELECT gymos.backfill_member_summaries($1)',[o]);
    let fired=false;
    const res=await scoped(o,c=>refreshDirtySummaries({query:async(s,v)=>{if(!fired&&re.test(s)&&when==='before'){fired=true;await writer(o);}const r=await c.query(s,v);if(!fired&&re.test(s)&&when==='after'){fired=true;await writer(o);}return r;}},o,500));
    const d=await dirtyOf(o,'m1'),after=await storedOf(o,'m1');
    await pool.query('SELECT gymos.backfill_member_summaries($1)',[o]);await scoped(o,c=>refreshDirtySummaries(c,o,500));const oracle=await storedOf(o,'m1');
    check(`A ${when} ${label}: m1 dirty or stored==clean recompute`,fired&&(d===1||after===oracle),`status=${res.status} dirtyAfterRace=${d} equal=${after===oracle}`);
  }}
  // B
  const ob=`rh2-B-${R}`;await seed(ob,20);let dead=0,ser=0,other=0,done=0;
  const txn=async(order,iter)=>{const c=await pool.connect();try{await c.query('BEGIN');for(const m of order){await c.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'visits',$2,$3,'a',$4)",[ob,`b${m}-${iter}-${Math.random()}`,Math.floor(Math.random()*1e9),JSON.stringify({id:'x',member:'m'+m,branch:'a',day:'2026-03-02',at:'2026-03-02T10:00:00.000Z',leftAt:'2026-03-02T11:00:00.000Z'})]);}await c.query('COMMIT');done++;}catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.code==='40P01')dead++;else if(e.code==='40001')ser++;else{other++;console.log('B other error',e.code,e.message);}}finally{c.release();}};
  const asc=[1,2,3,4,5,6,7,8],desc=[...asc].reverse();
  await Promise.all(Array.from({length:8},(_,k)=>(async()=>{for(let i=0;i<60;i++)await txn(k%2?asc:desc,i);})()));
  check('B opposite-order multi-statement writers: no deadlock or serialization error',dead===0&&ser===0&&other===0,`committed=${done} deadlocks=${dead} 40001=${ser} other=${other}`);
  const mv=async(ids)=>pool.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'visits','s'||g||'-'||random(),(random()*1e9)::int,'a',jsonb_build_object('id','x','member','m'||g,'branch','a','day','2026-03-02','at','2026-03-02T10:00:00.000Z','leftAt','2026-03-02T11:00:00.000Z') FROM unnest($2::int[]) g",[ob,ids]);
  let d2=0;await Promise.all(Array.from({length:8},(_,k)=>(async()=>{for(let i=0;i<60;i++){try{await mv(k%2?asc:desc);}catch(e){if(e.code==='40P01')d2++;else throw e;}}})()));
  check('B2 opposite-order multi-row single statements: no deadlock',d2===0,`deadlocks=${d2}`);
  // C
  const oc=`rh2-C-${R}`;await seed(oc,2000);
  const bulk=async(o,t)=>{const t0=performance.now();await pool.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'visits',$2||g,g,'a',jsonb_build_object('id',g,'member','m'||(g%2000+1),'branch','a','day','2026-03-02','at','2026-03-02T10:00:00.000Z','leftAt','2026-03-02T11:00:00.000Z') FROM generate_series(1,20000) g",[o,t]);return Math.round(performance.now()-t0);};
  const on=[];for(let i=0;i<3;i++)on.push(await bulk(oc,'on'+i+'-'));
  await pool.query('ALTER TABLE gymos.gym_entities DISABLE TRIGGER USER');const off=[];try{for(let i=0;i<3;i++)off.push(await bulk(oc,'off'+i+'-'));}finally{await pool.query('ALTER TABLE gymos.gym_entities ENABLE TRIGGER USER');}
  console.log('C bulk insert of 20,000 visits over 2,000 members, ms (3 runs): triggers ON',on,'| user triggers OFF',off,'(counters + summary marks + card sync together; not capacity)');
  check('C triggers re-enabled',(await pool.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='gymos.gym_entities'::regclass AND NOT tgisinternal AND tgenabled<>'O'")).rows[0].n===0);
  // D
  const oa=`rh2-D1-${R}`,ob2=`rh2-D2-${R}`;await seed(oa,3000,{visits:3});await seed(ob2,3000,{visits:3});
  for(const o of [oa,ob2])await pool.query('SELECT gymos.backfill_member_summaries($1)',[o]);
  const [x,y]=await Promise.all([scoped(oa,c=>refreshDirtySummaries(c,oa,500)),scoped(ob2,c=>refreshDirtySummaries(c,ob2,500))]);
  check('D two different owners refresh at once on separate connections: both ok (no cross-owner lock)',x.status==='ok'&&y.status==='ok',`statuses=${x.status},${y.status}`);
  const [p,q2]=await Promise.all([scoped(oa,c=>refreshDirtySummaries(c,oa,500)),scoped(oa,c=>refreshDirtySummaries(c,oa,500))]);
  const st2=[p.status,q2.status].sort().join(',');
  check('D same owner twice at once: one proceeds, the other busy or finds nothing left (advisory lock)',st2==='busy,ok'||st2==='ok,ok',`statuses=${st2}`);
}finally{
  for(const t of ['gym_member_summaries','gym_member_summary_dirty','gym_member_summary_ready','gym_entity_counters','gym_entities'])await pool.query(`DELETE FROM gymos.${t} WHERE owner_id LIKE 'rh2-%'`).catch(()=>{});
  await pool.query("DELETE FROM gymos.gym_states WHERE user_id LIKE 'rh2-%'").catch(()=>{});
  await pool.query('ALTER TABLE gymos.gym_entities ENABLE TRIGGER USER').catch(()=>{});
  await pool.end();
}
process.exit(failed?1:0);
