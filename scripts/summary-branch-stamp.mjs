// HELD, review-only. Resumable bounded prewarm after migration 20261122070000: stamps `branch` on existing summary rows and dirty marks from the member's CURRENT branch,
// WITHOUT recomputing anything (a stored v2 summary stays valid; staleness is carried by dirty marks, which keep their own gen). Keyset-paged on the primary key, one short
// transaction per batch (locks only the batch's rows, SKIP LOCKED so a live writer is never waited on), safe to stop and re-run. Rows it skips or that a writer re-marks are
// picked up by the lazy request-side path, so the app is correct whether or not this ever runs; this only avoids the recompute wave after the migration.
// Run with the migration role: MIGRATION_DATABASE_URL=... node scripts/summary-branch-stamp.mjs [batch=500] --confirm-trigger-history
// Opt-in only: without --confirm-trigger-history it refuses and the default rollout is the full recompute (backfill_member_summaries).
import pg from 'pg';
const TABLES=[['gymos.gym_member_summaries','member_id'],['gymos.gym_member_summary_dirty','member_id']];
// Safety rests on ONE invariant: from the moment the summaries exist (migration 20261121180000) every writer of gym_entities marks the affected member dirty through the statement
// triggers, including a branch move. A moved member therefore keeps a dirty mark, and the mark (not the stamped branch) forces its recompute. Stamping is NOT safe for rows written while
// those triggers were disabled (session_replication_role=replica, ALTER TABLE ... DISABLE TRIGGER, some bulk restores): the preflight refuses when the triggers are not enabled now, and an
// operator who ever disabled them must run backfill_member_summaries (full recompute) instead of this script. The stored summary carries no member branch, so the invariant cannot be re-checked per row.
export async function preflight(pool,{confirmedTriggerHistory=false}={}){
  if(!confirmedTriggerHistory)throw new Error('stamp refused by default: the mark-on-every-write history of this database is not confirmed. Default rollout is the full recompute (SELECT gymos.backfill_member_summaries(owner)). Re-run with --confirm-trigger-history only after verifying the three summary triggers were enabled for every write since 20261121180000 (no replica-mode restore, no DISABLE TRIGGER).');
  const r=(await pool.query("SELECT r.rolsuper OR r.rolbypassrls AS bypass,(SELECT bool_or(c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gymos' AND c.relname IN ('gym_member_summaries','gym_member_summary_dirty','gym_entities')) AS forced,(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='gymos.gym_entities'::regclass AND t.tgname IN ('gym_entities_msum_ins','gym_entities_msum_upd','gym_entities_msum_del') AND t.tgenabled='O') AS trig,(SELECT count(*) FROM pg_attribute WHERE attrelid='gymos.gym_member_summaries'::regclass AND attname='branch' AND NOT attisdropped) AS col FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
  if(!r.col)throw new Error('stamp refused: migration 20261122070000 (branch column) is not applied');
  if(r.forced&&!r.bypass)throw new Error('stamp refused: current role is neither superuser nor BYPASSRLS but the tables use FORCE ROW LEVEL SECURITY, so it would see zero rows and stamp nothing');
  if(Number(r.trig)!==3)throw new Error('stamp refused: the three member-summary triggers on gym_entities are not all enabled, so the mark-on-every-write invariant does not hold; use backfill_member_summaries instead');
}
export async function stampBranches(pool,{batch=500,sleepMs=0,onBatch,confirmedTriggerHistory=false}={}){
  await preflight(pool,{confirmedTriggerHistory});
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
  // Loud residue report. Live = the member row exists. NULL rows of live members that remain were locked by a writer (SKIP LOCKED), or raced; re-run. v0 rows (dues-only, no member) and orphan marks keep NULL by design.
  const q=async sql=>Number((await pool.query(sql)).rows[0].n);
  total.residual={
    liveSummariesNull:await q("SELECT count(*) n FROM gymos.gym_member_summaries s JOIN gymos.gym_entities e ON e.owner_id=s.owner_id AND e.collection='members' AND e.entity_id=s.member_id WHERE s.branch IS NULL"),
    liveMarksNull:await q("SELECT count(*) n FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id WHERE d.branch IS NULL"),
    v0DuesOnlyNull:await q("SELECT count(*) n FROM gymos.gym_member_summaries s WHERE s.branch IS NULL AND (s.stored->>'v')::int=0"),
    orphanMarksNull:await q("SELECT count(*) n FROM gymos.gym_member_summary_dirty d WHERE d.branch IS NULL AND NOT EXISTS (SELECT 1 FROM gymos.gym_entities e WHERE e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id)")};
  if(total.summaries+total.marks===0&&(total.residual.liveSummariesNull+total.residual.liveMarksNull)>0)throw new Error('stamp stamped 0 rows but live NULL-branch rows remain: '+JSON.stringify(total.residual));
  return total;
}
if(import.meta.url===`file://${process.argv[1]}`){
  const url=process.env.MIGRATION_DATABASE_URL;if(!url){console.error('MIGRATION_DATABASE_URL required');process.exit(2);}
  const pool=new pg.Pool({connectionString:url,max:1});
  try{const r=await stampBranches(pool,{batch:Number(process.argv.find(a=>/^\d+$/.test(a))??500),sleepMs:50,confirmedTriggerHistory:process.argv.includes('--confirm-trigger-history')});console.log(JSON.stringify(r));
    if(r.residual.liveSummariesNull+r.residual.liveMarksNull>0){console.error('RESIDUAL: live NULL-branch rows remain (locked or raced); re-run until residual is 0 before enabling any flag');process.exitCode=3;}}
  catch(e){console.error(String(e.message));process.exitCode=2;}finally{await pool.end();}
}
