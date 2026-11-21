// Reader and bounded refresher for the stored member summary inputs (migration 20261121180000, held). Exactness: a stored row is used only while its
// member is not in the dirty queue; dirty members are recomputed with computeStoredSummary (the oracle-tested model) from the member's own CURRENT rows.
// Nothing here uses the clock: callers apply deriveSummary at read time. Every refusal is a named status; the caller takes the exact full path.
import {readCounters,STATE_BYTE_LIMIT} from './workspace-slice.ts';
import type {GymState,Member} from './domain.ts';
import {computeStoredSummary,type StoredSummary} from './member-summary-model.ts';

type Sql={query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>};
export const MEMBER_CANDIDATE_MAX=10000; // the cap the operation path and restore enforce; more members fail closed
export const REFRESH_MAX=500; // dirty members per call (round trips and CPU; the BYTES bound is the counters bound below)
export const CHUNK=20; // members per history query: per-member index lookups keep the natural plan an index scan (a 100-id ANY flips to whole-collection bitmap work)
export const LOCK_WAIT_MS=1000; // availability guard for row-lock waits; the owner refresh lock is try-lock and never waits
export type Candidate={member:Member;stored:StoredSummary};
export type Refusal='unready'|'too-many-members'|'too-many-dirty'|'over-state-bound'|'busy'|'raced'|'stale';
export type CandidateResult={status:'ok';candidates:Candidate[];refreshed:number}|{status:Refusal};
export type RefreshResult={status:'ok';refreshed:number;remaining:number}|{status:Refusal};
const refuse=(status:Refusal):{status:Refusal}=>({status});

/** Work bound, derived and not chosen: the full path already reads (and the 20,000,000-byte rule already caps) the whole state, so the visits, payments and
 * invoices of ALL members together are at most this owner's counters byte bound. A refresh therefore transfers at most that much even if every member is dirty
 * and the history is skewed. Not ready, or already over the rule: refused before any history row is read. Rows are then read with LIMIT counters+1 per
 * collection, so a writer that grows a collection after this check (the check and the reads are separate READ COMMITTED statements) is detected as 'raced'
 * rather than read without bound. */
async function bound(c:Sql,owner:string){const k=await readCounters(c,owner);return k&&k.bytes<=STATE_BYTE_LIMIT?k:null;}
const busy=(e:unknown)=>(e as {code?:string})?.code==='55P03';

/** Recompute the listed members under the owner refresh lock. Re-reads everything the computation depends on (marks, stored rows and the MEMBER rows themselves)
 * after the lock, so a period or profile change committed since the caller's read can never be stored stale with its mark cleared. */
async function recompute(c:Sql,owner:string,need:string[],out:Map<string,Candidate>):Promise<Refusal|null>{
  if(!need.length)return null;
  const k=await bound(c,owner);if(!k)return 'over-state-bound';
  try{
    await c.query("SELECT set_config('lock_timeout',$1,true)",[String(LOCK_WAIT_MS)]);
    if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`msum:${owner}`])).rows.some(r=>(r as {ok:boolean}).ok))return 'busy';
    const lim=(coll:string)=>(k.counts[coll]??0)+1;
    for(let i=0;i<need.length;i+=CHUNK){
      const ids=need.slice(i,i+CHUNK);
      const gens=new Map((await c.query('SELECT member_id,gen FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows.map(r=>[(r as {member_id:string}).member_id,String((r as {gen:string|number}).gen)] as [string,string]));
      const members=new Map((await c.query("SELECT entity_id,payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members' AND entity_id=ANY($2::text[])",[owner,ids])).rows.map(r=>[(r as {entity_id:string}).entity_id,(r as {payload:Member}).payload] as [string,Member]));
      const have=new Map((await c.query('SELECT member_id,stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows.map(r=>[(r as {member_id:string}).member_id,(r as {stored:StoredSummary}).stored] as [string,StoredSummary]));
      const todo:string[]=[];
      for(const id of ids){const m=members.get(id);if(!m)continue; // deleted meanwhile: not a candidate
        if(gens.has(id)||!have.has(id))todo.push(id);else out.set(id,{member:m,stored:have.get(id)!});} // refreshed by someone else while we waited
      if(!todo.length)continue;
      const rowsOf=async(coll:string)=>{const rows=(await c.query("SELECT m.id AS member_id,x.payload FROM unnest($3::text[]) AS m(id) CROSS JOIN LATERAL (SELECT payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 AND payload->>'member'=m.id ORDER BY position,entity_id) x LIMIT "+lim(coll),[owner,coll,todo])).rows as {member_id:string;payload:unknown}[];return rows;};
      const [visits,payments,invoices]=await Promise.all([rowsOf('visits'),rowsOf('payments'),rowsOf('invoices')]);
      if(visits.length>lim('visits')-1||payments.length>lim('payments')-1||invoices.length>lim('invoices')-1)return 'raced'; // more rows than the counters said: a writer grew it
      for(const id of todo){
        const m=members.get(id)!;
        const local={members:[m],visits:visits.filter(v=>v.member_id===id).map(v=>v.payload),payments:payments.filter(v=>v.member_id===id).map(v=>v.payload),invoices:invoices.filter(v=>v.member_id===id).map(v=>v.payload)} as unknown as GymState;
        const s=computeStoredSummary(local,m);
        await c.query('INSERT INTO gymos.gym_member_summaries(owner_id,member_id,stored) VALUES($1,$2,$3) ON CONFLICT(owner_id,member_id) DO UPDATE SET stored=EXCLUDED.stored',[owner,id,JSON.stringify(s)]);
        // Rows read above are at least as new as the mark read under the lock; a later writer leaves a newer gen and the member stays dirty.
        if(gens.has(id))await c.query('DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=$2 AND gen=$3',[owner,id,gens.get(id)]);
        out.set(id,{member:m,stored:s});
      }
    }
    return null;
  }catch(e){if(busy(e))return 'busy';throw e;}
}

async function ready(c:Sql,owner:string){
  if(!(await c.query("SELECT to_regclass('gymos.gym_member_summaries') IS NOT NULL AND to_regclass('gymos.gym_member_summary_ready') IS NOT NULL AS ok")).rows.some(r=>(r as {ok:boolean}).ok))return false;
  return (await c.query('SELECT 1 FROM gymos.gym_member_summary_ready WHERE owner_id=$1',[owner])).rows.length>0;
}

/** Candidates for the members screen. Read-only unless the caller passes refresh:true (request-side writes are explicit): without it, any dirty or
 * missing member returns 'stale' and nothing is written. */
export async function readMemberCandidates(c:Sql,owner:string,branches:string[]|null,opts:{refresh?:boolean}={}):Promise<CandidateResult>{
  if(!await ready(c,owner))return refuse('unready');
  const filter=branches?' AND branch=ANY($2::text[])':'';const args=branches?[owner,branches]:[owner];
  const rows=(await c.query(`SELECT entity_id,payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members'${filter} ORDER BY position,entity_id LIMIT ${MEMBER_CANDIDATE_MAX+1}`,args)).rows as {entity_id:string;payload:Member}[];
  if(rows.length>MEMBER_CANDIDATE_MAX)return refuse('too-many-members');
  const members=rows.filter(r=>!r.payload.archived),ids=members.map(r=>r.entity_id);
  const dirty=new Set(ids.length?(await c.query('SELECT member_id FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows.map(r=>(r as {member_id:string}).member_id):[]);
  if(dirty.size>REFRESH_MAX)return refuse('too-many-dirty');
  const stored=new Map<string,StoredSummary>();
  if(ids.length)for(const r of (await c.query('SELECT member_id,stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows as {member_id:string;stored:StoredSummary}[])stored.set(r.member_id,r.stored);
  const need=ids.filter(id=>dirty.has(id)||!stored.has(id)); // a missing row is never trusted
  if(need.length>REFRESH_MAX)return refuse('too-many-dirty');
  const fresh=new Map<string,Candidate>();
  if(need.length){
    if(!opts.refresh)return refuse('stale');
    const why=await recompute(c,owner,need,fresh);if(why)return refuse(why);
  }
  const candidates:Candidate[]=[];
  for(const r of members){const f=fresh.get(r.entity_id);if(f)candidates.push(f);else if(!need.includes(r.entity_id))candidates.push({member:r.payload,stored:stored.get(r.entity_id)!});else return refuse('raced'); /* deleted while refreshing */}
  return{status:'ok',candidates,refreshed:fresh.size&&need.length?need.length:0};
}

/** Bounded refresher for the (separately gated) backfill and for mass-dirty events such as a restore: recomputes up to `max` dirty members under one bound check and
 * one lock, and reports how many marks are left. Also forgets marks and rows of deleted members. */
export async function refreshDirtySummaries(c:Sql,owner:string,max=REFRESH_MAX):Promise<RefreshResult>{
  if(!await ready(c,owner))return refuse('unready');
  await c.query("DELETE FROM gymos.gym_member_summary_dirty d WHERE d.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM gymos.gym_entities e WHERE e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id)",[owner]);
  await c.query("DELETE FROM gymos.gym_member_summaries s WHERE s.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM gymos.gym_entities e WHERE e.owner_id=s.owner_id AND e.collection='members' AND e.entity_id=s.member_id)",[owner]);
  const ids=(await c.query('SELECT member_id FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 ORDER BY gen LIMIT $2',[owner,max])).rows.map(r=>(r as {member_id:string}).member_id);
  const out=new Map<string,Candidate>();const why=await recompute(c,owner,ids,out);if(why)return refuse(why);
  const left=Number((await c.query('SELECT count(*) AS n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1',[owner])).rows[0]?.['n' as never]??0);
  return{status:'ok',refreshed:ids.length,remaining:left};
}
