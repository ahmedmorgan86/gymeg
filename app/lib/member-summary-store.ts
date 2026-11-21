// Reader for the stored member summary inputs (migration 20261121180000, held). Exactness: a stored row is used only while its member is
// not in the dirty queue; dirty members are recomputed here with computeStoredSummary (the oracle-tested model) from that member's own rows,
// read through the member-rows index. Nothing is derived from the clock here: callers apply deriveSummary at read time.
import type {GymState,Member} from './domain.ts';
import {computeStoredSummary,type StoredSummary} from './member-summary-model.ts';

type Sql={query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>};
export const MEMBER_CANDIDATE_MAX=10000; // the cap restore and member.add already enforce; more members fail closed
export const REFRESH_MAX=500; // dirty members recomputed per request; more is refused so one request can never become an unbounded history read
export type Candidate={member:Member;stored:StoredSummary};
export type CandidateResult={candidates:Candidate[];refreshed:number}|'unready'|'too-many-members'|'too-many-dirty'|'heavy-member';

/** Work guards (not product limits): a member whose own history exceeds them is never summarized here; the caller takes the exact full path. */
export const MEMBER_HISTORY_ROWS_MAX=20000; // rows per member per collection (visits, payments, invoices)
export const MEMBER_HISTORY_BYTES_MAX=16_000_000; // bytes of those rows per member
type Heavy={heavy:true};
/** Recompute and store the summary of each listed member from that member's own rows, then clear its dirty mark unless a writer re-marked it since.
 * Serialized per owner by a transaction advisory lock, and the marks are re-read under it: two refreshers can never write an older computation over a newer one
 * (a late refresher finds the mark already cleared and the newer row stored). Each member's rows are read with LIMIT guard+1, so work per member is bounded. */
async function recompute(c:Sql,owner:string,byId:Map<string,Member>,need:string[],stored:Map<string,StoredSummary|Heavy>){
  if(!need.length)return;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`msum:${owner}`]);
  for(let i=0;i<need.length;i+=100){
    const ids=need.slice(i,i+100);
    const gens=new Map((await c.query('SELECT member_id,gen FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows.map(r=>[(r as {member_id:string}).member_id,String((r as {gen:string|number}).gen)] as [string,string]));
    const have=new Map((await c.query('SELECT member_id,stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows.map(r=>[(r as {member_id:string}).member_id,(r as {stored:StoredSummary|Heavy}).stored] as [string,StoredSummary|Heavy]));
    const chunk=ids.filter(id=>{if(gens.has(id)||!have.has(id))return true;stored.set(id,have.get(id)!);return false;}); // refreshed by someone else while we waited
    if(!chunk.length)continue;
    const rowsOf=async(collection:string)=>(await c.query("SELECT m.id AS member_id,x.payload FROM unnest($3::text[]) AS m(id) CROSS JOIN LATERAL (SELECT payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 AND payload->>'member'=m.id ORDER BY position,entity_id LIMIT "+(MEMBER_HISTORY_ROWS_MAX+1)+") x",[owner,collection,chunk])).rows as {member_id:string;payload:unknown}[];
    const [visits,payments,invoices]=await Promise.all([rowsOf('visits'),rowsOf('payments'),rowsOf('invoices')]);
    const per=new Map<string,{rows:number;bytes:number;over:boolean}>();
    for(const [coll,rows] of [['v',visits],['p',payments],['i',invoices]] as const){const count=new Map<string,number>();for(const r of rows){const x=per.get(r.member_id)??{rows:0,bytes:0,over:false};x.rows++;x.bytes+=Buffer.byteLength(JSON.stringify(r.payload));count.set(r.member_id,(count.get(r.member_id)??0)+1);per.set(r.member_id,x);}for(const [id,n] of count)if(n>MEMBER_HISTORY_ROWS_MAX)per.get(id)!.over=true;void coll;}
    for(const id of chunk){
      const m=byId.get(id)!,g=per.get(id)??{rows:0,bytes:0,over:false};let s:StoredSummary|Heavy;
      if(g.over||g.bytes>MEMBER_HISTORY_BYTES_MAX)s={heavy:true}; // fail closed and remember, so later reads refuse without probing again until a write re-marks it
      else{
        const local={members:[m],visits:visits.filter(v=>v.member_id===id).map(v=>v.payload),payments:payments.filter(v=>v.member_id===id).map(v=>v.payload),invoices:invoices.filter(v=>v.member_id===id).map(v=>v.payload)} as unknown as GymState;
        s=computeStoredSummary(local,m);
      }
      await c.query('INSERT INTO gymos.gym_member_summaries(owner_id,member_id,stored) VALUES($1,$2,$3) ON CONFLICT(owner_id,member_id) DO UPDATE SET stored=EXCLUDED.stored',[owner,id,JSON.stringify(s)]);
      // The rows read here are at least as new as the mark read above; a writer that marks again after this read keeps the member dirty.
      if(gens.has(id))await c.query('DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=$2 AND gen=$3',[owner,id,gens.get(id)]);
      stored.set(id,s);
    }
  }
}
/** Bounded refresher for the (separately gated) backfill and for mass-dirty events such as a restore: recomputes up to `max` dirty members and reports how many are left. */
export async function refreshDirtySummaries(c:Sql,owner:string,max=REFRESH_MAX):Promise<{refreshed:number;remaining:number}|'unready'>{
  if(!(await c.query('SELECT 1 FROM gymos.gym_member_summary_ready WHERE owner_id=$1',[owner])).rows.length)return 'unready';
  await c.query("DELETE FROM gymos.gym_member_summary_dirty d WHERE d.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM gymos.gym_entities e WHERE e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id)",[owner]);
  const dirty=(await c.query('SELECT member_id,gen FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 ORDER BY gen LIMIT $2',[owner,max])).rows as {member_id:string;gen:string|number}[];
  const ids=dirty.map(d=>d.member_id);
  const byId=new Map((ids.length?(await c.query("SELECT entity_id,payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members' AND entity_id=ANY($2::text[])",[owner,ids])).rows:[] as unknown[]).map(r=>[(r as {entity_id:string}).entity_id,(r as {payload:Member}).payload] as [string,Member]));
  await recompute(c,owner,byId,ids.filter(i=>byId.has(i)),new Map());
  const left=Number((await c.query('SELECT count(*) AS n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1',[owner])).rows[0]?.['n' as never]??0);
  return{refreshed:ids.length,remaining:left};
}
export async function readMemberCandidates(c:Sql,owner:string,branches:string[]|null):Promise<CandidateResult>{
  if(!(await c.query("SELECT to_regclass('gymos.gym_member_summaries') IS NOT NULL AND to_regclass('gymos.gym_member_summary_ready') IS NOT NULL AS ok")).rows.some(r=>(r as {ok:boolean}).ok))return 'unready';
  if(!(await c.query('SELECT 1 FROM gymos.gym_member_summary_ready WHERE owner_id=$1',[owner])).rows.length)return 'unready';
  const filter=branches?' AND branch=ANY($2::text[])':'';const args=branches?[owner,branches]:[owner];
  const rows=(await c.query(`SELECT entity_id,payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members'${filter} ORDER BY position,entity_id LIMIT ${MEMBER_CANDIDATE_MAX+1}`,args)).rows as {entity_id:string;payload:Member}[];
  if(rows.length>MEMBER_CANDIDATE_MAX)return 'too-many-members';
  // Forget marks and rows of members that no longer exist (deleted members are never candidates, so nothing else would clear them).
  await c.query("DELETE FROM gymos.gym_member_summary_dirty d WHERE d.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM gymos.gym_entities e WHERE e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id)",[owner]);
  await c.query("DELETE FROM gymos.gym_member_summaries s WHERE s.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM gymos.gym_entities e WHERE e.owner_id=s.owner_id AND e.collection='members' AND e.entity_id=s.member_id)",[owner]);
  const members=rows.filter(r=>!r.payload.archived);
  const ids=members.map(r=>r.entity_id);
  const dirty=ids.length?(await c.query('SELECT member_id,gen FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows as {member_id:string;gen:string|number}[]:[];
  if(dirty.length>REFRESH_MAX)return 'too-many-dirty';
  const stored=new Map<string,StoredSummary|Heavy>();
  if(ids.length)for(const r of (await c.query('SELECT member_id,stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows as {member_id:string;stored:StoredSummary}[])stored.set(r.member_id,r.stored);
  const dirtyGen=new Map(dirty.map(d=>[d.member_id,String(d.gen)]));
  const need=ids.filter(id=>dirtyGen.has(id)||!stored.has(id)); // a missing row is treated as dirty (never trusted)
  if(need.length>REFRESH_MAX)return 'too-many-dirty';
  const byId=new Map(members.map(r=>[r.entity_id,r.payload]));
  await recompute(c,owner,byId,need,stored as Map<string,StoredSummary|Heavy>);
  if([...stored.values()].some(s=>(s as Heavy).heavy))return 'heavy-member';
  return{candidates:members.map(r=>({member:r.payload,stored:stored.get(r.entity_id) as StoredSummary})),refreshed:need.length};
}
