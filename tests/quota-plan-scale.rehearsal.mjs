// Plan-scale comparison on real PG16, runtime role gymos_app (FORCE RLS). Owners of N=3000 and N=10000 members; the measured branch has 100 members (g%100=0). Summary rows are REAL rows for every member
// (stored v=2, branch set). 'owner-wide' is the pre-migration shape (joins keyed by owner only); 'branch-scoped' is the shape that uses gym_member_summaries(owner,branch,member) and
// gym_member_summary_dirty(owner,branch,gen) from migration 20261122070000. Buffers = top plan node shared hit+read, best of 3 EXPLAIN (ANALYZE,BUFFERS).
import pg from 'pg';
const url=process.env.REHEARSAL_DATABASE_URL;if(!/rehearsal_/.test(url??'')){console.error('refusing');process.exit(2);}
const pool=new pg.Pool({connectionString:url,max:2});
const Q={
 'drain select owner-wide':"SELECT d.member_id FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id AND e.branch=$2 WHERE d.owner_id=$1 ORDER BY d.gen LIMIT $3",
 'drain select branch-scoped':"SELECT member_id FROM (SELECT d.member_id,d.gen FROM gymos.gym_member_summary_dirty d WHERE d.owner_id=$1 AND d.branch=$2 UNION ALL SELECT e.entity_id,0 FROM gymos.gym_entities e LEFT JOIN gymos.gym_member_summaries s ON s.owner_id=e.owner_id AND s.member_id=e.entity_id AND s.branch=$2 WHERE e.owner_id=$1 AND e.collection='members' AND e.branch=$2 AND COALESCE(e.payload->>'archived','false')<>'true' AND (s.member_id IS NULL OR s.stored->>'v'<>'2')) w GROUP BY member_id ORDER BY min(gen),member_id LIMIT $3",
 'candidates owner-wide':"SELECT e.entity_id,e.payload,s.stored,d.gen FROM gymos.gym_entities e LEFT JOIN gymos.gym_member_summaries s ON s.owner_id=e.owner_id AND s.member_id=e.entity_id LEFT JOIN gymos.gym_member_summary_dirty d ON d.owner_id=e.owner_id AND d.member_id=e.entity_id WHERE e.owner_id=$1 AND e.collection='members' AND e.branch=ANY($2::text[]) ORDER BY e.position,e.entity_id LIMIT 10001",
 'candidates branch-scoped':"SELECT e.entity_id,e.payload,s.stored,d.gen FROM gymos.gym_entities e LEFT JOIN gymos.gym_member_summaries s ON s.owner_id=e.owner_id AND s.member_id=e.entity_id AND s.branch=ANY($2::text[]) LEFT JOIN gymos.gym_member_summary_dirty d ON d.owner_id=e.owner_id AND d.member_id=e.entity_id AND d.branch=ANY($2::text[]) WHERE e.owner_id=$1 AND e.collection='members' AND e.branch=ANY($2::text[]) ORDER BY e.position,e.entity_id LIMIT 10001"};
const asRole=async(o,work)=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE gymos_app');await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);const r=await work(c);await c.query('ROLLBACK');return r;}finally{c.release();}};
const cost=(o,sql,args)=>asRole(o,async c=>{let best=null;for(let i=0;i<3;i++){const r=(await c.query('EXPLAIN (ANALYZE,BUFFERS,COSTS OFF,TIMING OFF) '+sql,args)).rows.map(x=>x['QUERY PLAN']);const l=r.find(x=>/Buffers: shared/.test(x))||'';const buf=Number(l.match(/hit=(\d+)/)?.[1]??0)+Number(l.match(/read=(\d+)/)?.[1]??0);const ex=Number(r.find(x=>/Execution Time/.test(x)).match(/([\d.]+)/)[1]);if(!best||ex<best.ex)best={buf,ex,plan:r};}return best;});
const out=[];
try{
 for(const N of [3000,10000]){const o='ps-'+N+'-'+Date.now();
  await pool.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,'{\"_entityStorage\":1}',1,'x')",[o]);
  await pool.query(`INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'members','m'||g,g,b,jsonb_build_object('id','m'||g,'branch',b,'joined','2025-01-01','expires','2026-12-31') FROM (SELECT g,CASE WHEN g%100=0 THEN 'd' ELSE (ARRAY['a','b','c'])[1+g%3] END b FROM generate_series(0,$2) g) x`,[o,N-1]);
  await pool.query('DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=$1',[o]);
  await pool.query(`INSERT INTO gymos.gym_member_summaries(owner_id,member_id,stored,branch) SELECT owner_id,entity_id,jsonb_build_object('v',2,'visitCount',0,'pad',repeat('x',300)),branch FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members'`,[o]);
  await pool.query('ANALYZE gymos.gym_entities;ANALYZE gymos.gym_member_summaries');
  const mark=async(where)=>{await pool.query('DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=$1',[o]);await pool.query(`INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch) SELECT $1,entity_id,nextval('gymos.member_summary_gen'),branch FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members' ${where}`,[o]);await pool.query('ANALYZE gymos.gym_member_summary_dirty');};
  const scen=[['no backlog',"AND false"],['own branch dirty',"AND branch='d'"],['other branches dirty',"AND branch<>'d'"],['whole owner dirty','']];
  const orphans=async()=>pool.query(`INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch) SELECT $1,'gone'||g,nextval('gymos.member_summary_gen'),(ARRAY['a','b','c'])[1+g%3] FROM generate_series(1,5000) g`,[o]);
  const run=async(label)=>{const row={N,scenario:label};for(const [k,sql] of Object.entries(Q)){const a=k.startsWith('drain')?[o,'d',101]:[o,['d']];const r=await cost(o,sql,a);row[k]=r.buf+' buf '+r.ex+'ms';}console.log(JSON.stringify(row));return row;};
  for(const [label,w] of scen){await mark(w);out.push(await run(label));}
  await orphans();await pool.query('ANALYZE gymos.gym_member_summary_dirty');out.push(await run('whole owner dirty + 5000 orphan marks (other branches)'));
  if(N===10000){await mark("AND branch='d'");const r=await cost(o,Q['candidates branch-scoped'],[o,['d']]);console.log('\n=== candidates branch-scoped plan (own branch dirty, N=10000)\n'+r.plan.join('\n'));}
  for(const t of ['gym_entities','gym_member_summaries','gym_member_summary_dirty','gym_member_summary_ready'])await pool.query(`DELETE FROM gymos.${t} WHERE owner_id=$1`,[o]);await pool.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[o]);}
}finally{await pool.end();}
