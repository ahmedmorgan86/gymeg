// REHEARSAL SCRIPT (disposable rehearsal_* database only). Proves for migration 20261122070000_member_summary_branch.sql on real PG16:
//  1. the runtime role gymos_app cannot execute msum_mark, the three trigger functions or the backfill/reset functions directly;
//  2. applying the migration while a writer commits visit inserts continuously: writer's worst commit latency, migration duration, no writer error, and the marks written before/after carry the right branch;
//  3. NULL-branch compatibility: rows written by the OLD trigger functions (no branch) remain visible to member-key dirty detection.
import pg from 'pg';import {readFileSync} from 'node:fs';
const url=process.env.REHEARSAL_DATABASE_URL;if(!/rehearsal_/.test(url??'')){console.error('refusing');process.exit(2);}
const pool=new pg.Pool({connectionString:url,max:6});let failed=0;const check=(l,ok,x='')=>{console.log(ok?'PASS':'FAIL',l,x);if(!ok)failed++;};
const old=readFileSync(new URL('../supabase/migrations/20261121180000_member_summary_inputs.sql',import.meta.url),'utf8'),mig=readFileSync(new URL('../supabase/migrations/20261122070000_member_summary_branch.sql',import.meta.url),'utf8');
const O='qm-'+Date.now();
try{
  // 1. direct execution by the runtime role
  for(const [label,sql] of [['msum_mark',"SELECT gymos.msum_mark(ARRAY['x'],ARRAY['y'],ARRAY['a'])"],['backfill_member_summaries',"SELECT gymos.backfill_member_summaries('x')"],['mark_member_summary_dirty_ins',"SELECT gymos.mark_member_summary_dirty_ins()"],['mark_member_summary_dirty_upd',"SELECT gymos.mark_member_summary_dirty_upd()"],['mark_member_summary_dirty_del',"SELECT gymos.mark_member_summary_dirty_del()"],['reset_member_summaries',"SELECT gymos.reset_member_summaries()"],['msum_oversize (pure helper)',"SELECT gymos.msum_oversize('x')"]]){
    const c=await pool.connect();let err=null,ok=false;try{await c.query('BEGIN');await c.query('SET LOCAL ROLE gymos_app');await c.query(sql);ok=true;}catch(e){err=e;}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
    if(label.startsWith('msum_oversize'))console.log('INFO',label,ok?'executable (immutable pure function, no table access)':'denied '+err.code);
    else check('runtime role cannot execute '+label,!ok&&err?.code==='42501',err?`${err.code} ${err.message.slice(0,70)}`:'EXECUTED');
  }
  // 2. concurrent writer during the migration
  await pool.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,'{\"_entityStorage\":1}',1,'x')",[O]);
  await pool.query(`INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'members','m'||g,g,(ARRAY['a','b','c'])[1+g%3],jsonb_build_object('id','m'||g,'branch',(ARRAY['a','b','c'])[1+g%3],'joined','2025-01-01','expires','2026-12-31') FROM generate_series(0,19999) g`,[O]);
  await pool.query('DELETE FROM gymos.gym_member_summaries WHERE owner_id=$1',[O]);
  await pool.query(`INSERT INTO gymos.gym_member_summaries(owner_id,member_id,stored) SELECT owner_id,entity_id,jsonb_build_object('v',2,'pad',repeat('x',300)) FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members'`,[O]);
  // return the schema to the pre-migration state, then the old trigger functions
  await pool.query('DROP INDEX IF EXISTS gymos.gym_member_summaries_branch;DROP INDEX IF EXISTS gymos.gym_member_summary_dirty_branch;ALTER TABLE gymos.gym_member_summaries DROP COLUMN IF EXISTS branch;ALTER TABLE gymos.gym_member_summary_dirty DROP COLUMN IF EXISTS branch;');
  await pool.query(old);
  await pool.query("DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=$1",[O]);
  let stop=false,n=0,worst=0,werr=0;const lat=[];
  const writer=(async()=>{while(!stop){const t=performance.now();try{await pool.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'visits',$2,$3,'a',$4)",[O,'wv'+n,900000+n,JSON.stringify({id:'wv'+n,member:'m'+(n%20000),branch:'a',day:'2026-03-02',at:'2026-03-02T09:00:00.000Z'})]);}catch(e){werr++;console.log('writer error',e.message.slice(0,80));}const d=performance.now()-t;lat.push(d);worst=Math.max(worst,d);n++;await new Promise(r=>setTimeout(r,5));}})();
  await new Promise(r=>setTimeout(r,300));const beforeN=n;
  const c=await pool.connect();const t0=performance.now();let merr=null;try{await c.query('BEGIN');await c.query(mig);await c.query('COMMIT');}catch(e){merr=e;await c.query('ROLLBACK').catch(()=>{});}finally{c.release();}
  const migMs=Math.round(performance.now()-t0);await new Promise(r=>setTimeout(r,300));stop=true;await writer;
  check('migration applied under a concurrent writer',merr===null,merr?merr.message:`${migMs} ms`);
  console.log('writer commits',n,'during-migration commits',n-beforeN,'errors',werr,'worst commit latency ms',Math.round(worst),'p50',Math.round(lat.sort((a,b)=>a-b)[Math.floor(lat.length/2)]));
  check('no writer error',werr===0);
  // 3. old rows have NULL branch, new rows carry the member branch
  const nulls=Number((await pool.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND branch IS NULL",[O])).rows[0].n),withB=Number((await pool.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND branch IS NOT NULL",[O])).rows[0].n);
  console.log('dirty marks: NULL-branch (old trigger)',nulls,'with branch (new trigger)',withB);check('both generations present and compatible',nulls>0&&withB>0);
  const bad=Number((await pool.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id WHERE d.owner_id=$1 AND d.branch IS NOT NULL AND d.branch<>e.branch",[O])).rows[0].n);check('new marks carry the member branch',bad===0);
  // 4. the migration's SET LOCAL needs a transaction: one multi-statement simple query is one implicit transaction on the wire (what a runner that sends the file text does)
  {const c=await pool.connect();try{
    await c.query('DROP INDEX IF EXISTS gymos.gym_member_summaries_branch');
    const res=await c.query(mig.replace(/\s*$/,'')+";SELECT current_setting('lock_timeout') AS lt,current_setting('statement_timeout') AS st");
    const last=Array.isArray(res)?res.at(-1):res;const after=(await c.query("SELECT current_setting('lock_timeout') AS lt")).rows[0].lt;
    check('SET LOCAL applies inside the migration file sent as one query, and does not leak after',last.rows[0].lt==='5s'&&last.rows[0].st==='1min'&&after==='0',`inside lock_timeout=${last.rows[0].lt} statement_timeout=${last.rows[0].st}; after=${after}`);
  }finally{c.release();}}
  // 5. bounded resumable prewarm: stamp the NULL-branch summaries and marks with no recompute, under a concurrent writer
  {const {stampBranches}=await import('../scripts/summary-branch-stamp.mjs');
   await pool.query("UPDATE gymos.gym_member_summaries SET branch=NULL WHERE owner_id=$1",[O]);
   const need=async()=>Number((await pool.query("SELECT count(*) n FROM gymos.gym_entities e LEFT JOIN gymos.gym_member_summaries s ON s.owner_id=e.owner_id AND s.member_id=e.entity_id AND s.branch=e.branch WHERE e.owner_id=$1 AND e.collection='members' AND (s.member_id IS NULL OR s.stored->>'v'<>'2')",[O])).rows[0].n);
   const before=await need();const storedBefore=(await pool.query("SELECT md5(string_agg(stored::text,'|' ORDER BY member_id)) h FROM gymos.gym_member_summaries WHERE owner_id=$1",[O])).rows[0].h;
   let stop2=false,n2=0,w2=0,e2=0;const wr=(async()=>{while(!stop2){const t=performance.now();const k=n2++;try{await pool.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'visits',$2,$3,'a',$4)",[O,'sv'+k,950000+k,JSON.stringify({id:'sv'+k,member:'m'+(5000+k%10000),branch:'a',day:'2026-03-02',at:'2026-03-02T09:00:00.000Z',leftAt:'2026-03-02T10:00:00.000Z'})]);}catch(e){e2++;if(e2<3)console.log('stamp-writer error',e.message.slice(0,100));}w2=Math.max(w2,performance.now()-t);await new Promise(r=>setTimeout(r,2));}})();
   const t0=performance.now();const tot=await stampBranches(pool,{batch:500});const ms=Math.round(performance.now()-t0);stop2=true;await wr;
   const after=await need();const storedAfter=(await pool.query("SELECT md5(string_agg(stored::text,'|' ORDER BY member_id)) h FROM gymos.gym_member_summaries WHERE owner_id=$1",[O])).rows[0].h;
   const nullLeft=Number((await pool.query("SELECT (SELECT count(*) FROM gymos.gym_member_summaries WHERE owner_id=$1 AND branch IS NULL)+(SELECT count(*) FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id WHERE d.owner_id=$1 AND d.branch IS NULL) n",[O])).rows[0].n);
   console.log('stamp:',JSON.stringify(tot),ms+' ms; members needing a recompute before',before,'after',after,'; concurrent writer commits',n2,'errors',e2,'worst ms',Math.round(w2));
   check('stamp makes every live member current without recompute (stored bytes unchanged)',before>0&&after===0&&storedBefore===storedAfter&&nullLeft===0,`before=${before} after=${after} nullLeft=${nullLeft}`);
   check('stamp ran under a concurrent writer with no writer error',e2===0);
   const again=await stampBranches(pool,{batch:500});check('re-run is a no-op (resumable)',again.summaries===0&&again.marks===0,JSON.stringify(again));}
}catch(e){console.error('ERROR',e);failed++;}
finally{for(const t of ['gym_entities','gym_member_summaries','gym_member_summary_dirty','gym_member_summary_ready'])await pool.query(`DELETE FROM gymos.${t} WHERE owner_id=$1`,[O]).catch(()=>{});await pool.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[O]).catch(()=>{});await pool.end();}
process.exit(failed?1:0);
