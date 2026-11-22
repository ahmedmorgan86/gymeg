// HELD, review-only. Resumable bounded prewarm after migration 20261122070000: stamps `branch` on existing summary rows and dirty marks from the member's CURRENT branch,
// WITHOUT recomputing anything (a stored v2 summary stays valid; staleness is carried by dirty marks, which keep their own gen). Keyset-paged on the primary key, one short
// transaction per batch (locks only the batch's rows, SKIP LOCKED so a live writer is never waited on), safe to stop and re-run. Rows it skips or that a writer re-marks are
// picked up by the lazy request-side path, so the app is correct whether or not this ever runs; this only avoids the recompute wave after the migration.
// Run with the migration role: MIGRATION_DATABASE_URL=... node scripts/summary-branch-stamp.mjs [batch=500] [sleepMs=50]
import pg from 'pg';
const TABLES=[['gymos.gym_member_summaries','member_id'],['gymos.gym_member_summary_dirty','member_id']];
export async function stampBranches(pool,{batch=500,sleepMs=0,onBatch}={}){
  const total={summaries:0,marks:0,batches:0};
  for(const [table,col] of TABLES){
    let last=['',''];
    for(;;){
      const c=await pool.connect();let page,n=0;
      try{
        await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'");await c.query("SET LOCAL statement_timeout='10s'");
        page=(await c.query(`SELECT owner_id,${col} AS m FROM ${table} WHERE (owner_id,${col})>($1,$2) ORDER BY owner_id,${col} LIMIT $3`,[last[0],last[1],batch])).rows;
        if(page.length){
          const r=await c.query(`UPDATE ${table} t SET branch=e.branch FROM gymos.gym_entities e WHERE t.branch IS NULL AND e.collection='members' AND e.owner_id=t.owner_id AND e.entity_id=t.${col} AND t.ctid IN (SELECT x.ctid FROM ${table} x WHERE (x.owner_id,x.${col})>($1,$2) AND (x.owner_id,x.${col})<=($3,$4) AND x.branch IS NULL ORDER BY x.owner_id,x.${col} FOR UPDATE SKIP LOCKED)`,[last[0],last[1],page.at(-1).owner_id,page.at(-1).m]);
          n=r.rowCount;
        }
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
      if(!page.length)break;
      last=[page.at(-1).owner_id,page.at(-1).m];total[table.endsWith('summaries')?'summaries':'marks']+=n;total.batches++;
      onBatch?.(total);if(sleepMs)await new Promise(r=>setTimeout(r,sleepMs));
    }
  }
  return total;
}
if(import.meta.url===`file://${process.argv[1]}`){
  const url=process.env.MIGRATION_DATABASE_URL;if(!url){console.error('MIGRATION_DATABASE_URL required');process.exit(2);}
  const pool=new pg.Pool({connectionString:url,max:1});
  try{console.log(JSON.stringify(await stampBranches(pool,{batch:Number(process.argv[2]??500),sleepMs:Number(process.argv[3]??50)})));}finally{await pool.end();}
}
