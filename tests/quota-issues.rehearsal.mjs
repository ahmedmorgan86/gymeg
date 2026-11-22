// REHEARSAL SCRIPT, NOT RUN BY THE SUITE. Real Postgres (disposable database named rehearsal_*), runtime role gymos_app under FORCE RLS. Seeds owners prefixed "qr-", removes them at the end.
// Measures the quota-issues read: every statement's wall time and plan (EXPLAIN ANALYZE BUFFERS as the runtime role), the drain convergence per request, real concurrent drainers, and worst-case history.
//   REHEARSAL_DATABASE_URL=postgres://postgres@localhost/rehearsal_w?host=/tmp/pgdata node --experimental-strip-types tests/quota-issues.rehearsal.mjs > /downloads/quota-issues-pg16.txt
import {registerHooks} from 'node:module';import pg from 'pg';import {writeFileSync} from 'node:fs';
const url=process.env.REHEARSAL_DATABASE_URL??'';let name='';try{name=decodeURIComponent(new URL(url).pathname.replace(/^\//,''));}catch{}
if(!/^rehearsal_/.test(name)){console.error('refusing: database must start with rehearsal_');process.exit(2);}
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},load(u,x,n){if(u.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:'export const getPool=()=>globalThis.__rhPool;export const isFirebaseConfigured=()=>false;'};return n(u,x);}});
const pool=globalThis.__rhPool=new pg.Pool({connectionString:url,max:8});
const {readQuotaIssues,QUOTA_MAX_DIRTY}=await import('../app/lib/quota-issues-source.ts');
const {emptyState}=await import('../app/lib/domain.ts');const {normalize}=await import('../app/lib/extensions.ts');
const settings=normalize(emptyState()).settings;settings.timezone='Africa/Cairo';
const NOW='2026-03-15T12:00:00.000Z';let failed=0;const check=(l,ok,x='')=>{console.log(ok?'PASS':'FAIL',l,x);if(!ok)failed++;};
const owners=[];
async function seed(o,members,visits,heavy){owners.push(o);
  await pool.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,'{\"_entityStorage\":1}',1,'x')",[o]);
  await pool.query(`INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'members','m'||g,g,(ARRAY['a','b','c'])[1+g%3],jsonb_build_object('id','m'||g,'branch',(ARRAY['a','b','c'])[1+g%3],'joined','2025-01-01','expires','2026-12-31','membershipPeriods',jsonb_build_array(jsonb_build_object('id','p'||g,'plan','pl','start','2025-01-01','end','2026-12-31','visits',CASE WHEN g%4=0 THEN 40 ELSE NULL END))) FROM generate_series(0,$2) g`,[o,members-1]);
  await pool.query(`INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'visits','v'||g,100000+g,(ARRAY['a','b','c'])[1+(g%members)%3],jsonb_build_object('id','v'||g,'member','m'||(g%members),'branch',(ARRAY['a','b','c'])[1+(g%members)%3],'day',to_char(date '2025-01-01'+(g%400),'YYYY-MM-DD'),'at',to_char(date '2025-01-01'+(g%400),'YYYY-MM-DD')||'T09:00:00.000Z','leftAt',to_char(date '2025-01-01'+(g%400),'YYYY-MM-DD')||'T09:30:00.000Z') FROM generate_series(0,$2) g,(SELECT $3::int AS members) mm`,[o,visits-1,members]);
  if(heavy)await pool.query(`INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'visits','hv'||g,900000+g,'a',jsonb_build_object('id','hv'||g,'member','m3','branch','a','day',to_char(date '2025-01-01'+(g%400),'YYYY-MM-DD'),'at',to_char(date '2025-01-01'+(g%400),'YYYY-MM-DD')||'T10:00:00.000Z','leftAt',to_char(date '2025-01-01'+(g%400),'YYYY-MM-DD')||'T10:30:00.000Z','sessions','[{},{}]'::jsonb) FROM generate_series(0,$2) g`,[o,heavy-1]);
  await pool.query('ANALYZE gymos.gym_entities');}
const asRole=async(o,work)=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE gymos_app');await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}};
const dirty=async(o,b)=>Number((await pool.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id WHERE d.owner_id=$1 AND ($2::text IS NULL OR e.branch=$2)",[o,b])).rows[0].n);
const req=(o,b,stmts)=>asRole(o,c=>readQuotaIssues((_o,work)=>work(stmts?{query:async(q,v)=>{const t=performance.now();const r=await c.query(q,v);stmts.push({ms:performance.now()-t,sql:String(q).slice(0,110).replace(/\s+/g,' '),rows:r.rowCount});return r;}}:c),{owner:o,branch:b,branches:null,settings,now:NOW}));
try{
  const O='qr-'+Date.now();console.log('PG',(await pool.query('select version()')).rows[0].version.slice(0,40));
  await seed(O,3000,60000,6000);console.log('seeded owner',O,'3000 members, 66000 visits (6000 on one member), dirty',await dirty(O,null));
  // drain convergence as the runtime role, branch a
  let i=0,last,worst=0;const lines=[];
  for(;i<30;i++){const st=[];const t0=performance.now();last=await req(O,'a',st);const ms=Math.round(performance.now()-t0);worst=Math.max(worst,ms);lines.push(`request ${i+1}: ${last.status}${last.reason?':'+last.reason:''} recomputed=${last.recomputed} remaining=${last.remaining??''} ms=${ms} statements=${st.length} slowest=${Math.round(Math.max(...st.map(s=>s.ms)))}ms`);if(last.status==='ok')break;}
  console.log(lines.join('\n'));check('branch a drains to ok as gymos_app',last.status==='ok');console.log('worst single request ms',worst,'; branch b dirty untouched:',await dirty(O,'b'));
  check('branch b marks untouched',await dirty(O,'b')>0);
  // steady state request: statements and timing, then plans
  const st=[];const t0=performance.now();const ok=await req(O,'a',st);console.log('steady-state ok request ms',Math.round(performance.now()-t0),'members',ok.members,'recomputed',ok.recomputed);
  for(const s of st)console.log('  ',Math.round(s.ms*10)/10+'ms','rows',s.rows,s.sql);
  // plans of the candidate select and the scoped dirty select (runtime role)
  const plan=async(label,sql,args)=>{const rows=await asRole(O,async c=>(await c.query('EXPLAIN (ANALYZE,BUFFERS,COSTS OFF,TIMING OFF) '+sql,args)).rows.map(r=>r['QUERY PLAN']));console.log('\n=== PLAN',label);console.log(rows.join('\n'));};
  await plan('scoped dirty select',"SELECT d.member_id FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id AND e.branch=$3 WHERE d.owner_id=$1 ORDER BY d.gen LIMIT $2",[O,10,'b']);
  await plan('candidate select (photo:false)',"SELECT e.entity_id,e.payload-'photo'-'health'-'vitals'-'measurements' AS payload,NULL::text AS photo_v,s.stored,d.gen FROM gymos.gym_entities e LEFT JOIN gymos.gym_member_summaries s ON s.owner_id=e.owner_id AND s.member_id=e.entity_id LEFT JOIN gymos.gym_member_summary_dirty d ON d.owner_id=e.owner_id AND d.member_id=e.entity_id WHERE e.owner_id=$1 AND e.collection='members' AND e.branch=ANY($2::text[]) ORDER BY e.position,e.entity_id LIMIT 10001",[O,['a']]);
  // real concurrent drainers on branch b (separate connections)
  const t1=performance.now();const rounds=[];
  for(let k=0;k<30;k++){const pair=await Promise.all([req(O,'b'),req(O,'b'),req(O,'b')]);rounds.push(pair.map(p=>p.status+(p.reason?':'+p.reason:'')+(p.recomputed!==undefined?'/'+p.recomputed:'')).join(' '));if(await dirty(O,'b')===0&&pair.some(p=>p.status==='ok'))break;}
  console.log('\nconcurrent drainers (3 connections) rounds:\n'+rounds.join('\n'),'\ntotal ms',Math.round(performance.now()-t1));
  check('concurrent drainers converge',await dirty(O,'b')===0);
  const busy=rounds.some(r=>/busy/.test(r));console.log('busy observed:',busy);
  const bq=await req(O,'b');check('b answer ok after concurrent drain',bq.status==='ok');
}catch(e){console.error('ERROR',e);failed++;}
finally{for(const o of owners){for(const t of ['gym_entities','gym_member_summaries','gym_member_summary_dirty','gym_member_summary_ready'])await pool.query(`DELETE FROM gymos.${t} WHERE owner_id=$1`,[o]).catch(()=>{});await pool.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[o]).catch(()=>{});}await pool.end();}
process.exit(failed?1:0);
