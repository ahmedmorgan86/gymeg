// Reader and bounded refresher for the stored member summary inputs (migration 20261121180000, held). Exactness: a stored row is used only while its
// member is not in the dirty queue; dirty members are recomputed with computeStoredSummary (the oracle-tested model) from the member's own CURRENT rows.
// Nothing here uses the clock: callers apply deriveSummary at read time. Every refusal is a named status; the caller takes the exact full path.
import {readCounters,STATE_BYTE_LIMIT} from './workspace-slice.ts';
import type {GymState,Member} from './domain.ts';
import {computeStoredSummary,memberDues,type StoredSummary} from './member-summary-model.ts';

type Sql={query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>};
export const MEMBER_CANDIDATE_MAX=10000; // the cap the operation path and restore enforce; more members fail closed
export const REFRESH_MAX=500; // dirty members per request-side read (round trips and CPU; the BYTES bound is the counters bound below)
export const CHUNK=20; // members per history query: per-member index lookups keep the natural plan an index scan (a 100-id ANY flips to whole-collection bitmap work)
export const LOCK_WAIT_MS=1000; // availability guard for row-lock waits; the owner refresh lock is try-lock and never waits
/** `member` carries no health/vitals/measurements and no inline photo (list/search never reads them; the packet ships them separately); `photoV` is the same 16-hex photo version
 * the packet uses (inline photo hash, else the stored photo row hash), null when the member has no photo. */
export type Candidate={member:Member;stored:StoredSummary;photoV?:string|null};
const LIST_STRIP=['photo','health','vitals','measurements'] as const;
const slim=(m:Member):Member=>{const o={...m} as Record<string,unknown>;for(const k of LIST_STRIP)delete o[k];return o as Member;};
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
const busy=(e:unknown)=>['55P03','40001'].includes((e as {code?:string})?.code??''); // lock timeout, or a serialization failure under the snapshot scope

type Rows={member_id:string;payload:unknown}[];
/** Recompute the listed members under the owner refresh lock. Re-reads everything the computation depends on (marks, stored rows and the MEMBER rows themselves)
 * after the lock, so a period or profile change committed since the caller's read can never be stored stale with its mark cleared. */
async function recompute(c:Sql,owner:string,need:string[],out:Map<string,Candidate>,asOf?:string):Promise<Refusal|null>{
  if(!need.length)return null;
  const k=await bound(c,owner);if(!k)return 'over-state-bound';
  // The body runs inside a savepoint: a lock timeout (55P03) or serialization failure (40001) aborts the statement, and only ROLLBACK TO leaves the caller's
  // transaction usable. lock_timeout is restored afterwards so it never leaks to the caller's later statements.
  const prev=String((await c.query("SELECT current_setting('lock_timeout') AS v")).rows[0]?.['v' as never]??'0');
  await c.query('SAVEPOINT msum_refresh');
  try{
    await c.query("SELECT set_config('lock_timeout',$1,true)",[String(LOCK_WAIT_MS)]);
    if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`msum:${owner}`])).rows.some(r=>(r as {ok:boolean}).ok)){await c.query('ROLLBACK TO SAVEPOINT msum_refresh');await c.query("SELECT set_config('lock_timeout',$1,true)",[prev]);return 'busy';}
    // The persisted horizon comes from the DATABASE clock. A caller-supplied asOf can only move it EARLIER (safe: more visits stay verbatim in the tail); a later
    // one is ignored, so a wrong or hostile clock can never fold a future-dated visit into the totals early.
    const dbNow=new Date(String((await c.query('SELECT now() AS t')).rows[0]?.['t' as never])).toISOString();
    const effective=asOf!==undefined&&Number.isFinite(Date.parse(asOf))&&Date.parse(asOf)<Date.parse(dbNow)?asOf:dbNow;
    const lim=(coll:string)=>(k.counts[coll]??0)+1;
    const gens=new Map<string,string>(),members=new Map<string,Member>(),have=new Map<string,StoredSummary>();
    for(let i=0;i<need.length;i+=1000){
      const ids=need.slice(i,i+1000);
      for(const r of (await c.query('SELECT member_id,gen FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows as {member_id:string;gen:string|number}[])gens.set(r.member_id,String(r.gen));
      for(const r of (await c.query("SELECT entity_id,payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members' AND entity_id=ANY($2::text[])",[owner,ids])).rows as {entity_id:string;payload:Member}[])members.set(r.entity_id,r.payload);
      for(const r of (await c.query('SELECT member_id,stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id=ANY($2::text[])',[owner,ids])).rows as {member_id:string;stored:StoredSummary}[])have.set(r.member_id,r.stored);
    }
    // Members that no longer exist (deleted, or invoices/payments naming an unknown member) keep a dues-only row (v:0) while they still own invoices, so the branch
    // dues total stays exact without a historical scan. v:0 rows are never candidates (candidates join the member rows). No invoices left: row and mark are dropped.
    for(const id of need){if(members.has(id))continue;
      const own=async(coll:string)=>(await c.query("SELECT payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 AND md5(payload->>'member')=md5($3) AND payload->>'member'=$3 ORDER BY position,entity_id LIMIT "+lim(coll),[owner,coll,id])).rows.map(r=>(r as {payload:unknown}).payload);
      const inv=await own('invoices'),pay=await own('payments');
      if(inv.length>lim('invoices')-1||pay.length>lim('payments')-1){await c.query('ROLLBACK TO SAVEPOINT msum_refresh');await c.query("SELECT set_config('lock_timeout',$1,true)",[prev]);return 'raced';}
      if(inv.length)await c.query('INSERT INTO gymos.gym_member_summaries(owner_id,member_id,stored) VALUES($1,$2,$3) ON CONFLICT(owner_id,member_id) DO UPDATE SET stored=EXCLUDED.stored',[owner,id,JSON.stringify({v:0,dues:memberDues({payments:pay,invoices:inv} as unknown as GymState,{id} as Member)})]);
      else await c.query('DELETE FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id=$2',[owner,id]);
      if(gens.has(id))await c.query('DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=$2 AND gen=$3',[owner,id,gens.get(id)]);
    }
    const todo:string[]=[];
    for(const id of need){const m=members.get(id);if(!m)continue; // deleted meanwhile: not a candidate
      if(gens.has(id)||!have.has(id)||have.get(id)!.v!==2||have.get(id)!.dues===undefined)todo.push(id);else out.set(id,{member:m,stored:have.get(id)!});} // refreshed by someone else while we waited
    if(!todo.length){await c.query('RELEASE SAVEPOINT msum_refresh');await c.query("SELECT set_config('lock_timeout',$1,true)",[prev]);return null;}
    const rowsOf=async(coll:string):Promise<Rows|'raced'>=>{
      const all:Rows=[];
      for(let i=0;i<todo.length;i+=CHUNK){
        const rows=(await c.query("SELECT m.id AS member_id,x.payload FROM unnest($3::text[]) AS m(id) CROSS JOIN LATERAL (SELECT payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 AND md5(payload->>'member')=md5(m.id) AND payload->>'member'=m.id ORDER BY position,entity_id) x LIMIT "+lim(coll),[owner,coll,todo.slice(i,i+CHUNK)])).rows as Rows;
        all.push(...rows);if(all.length>lim(coll)-1)return 'raced'; // more rows than the counters said: a writer grew it
      }
      return all;
    };
    let visits:Rows|'raced',payments:Rows|'raced',invoices:Rows|'raced';
    visits=await rowsOf('visits');payments=await rowsOf('payments');invoices=await rowsOf('invoices');
    if(visits==='raced'||payments==='raced'||invoices==='raced'){await c.query('ROLLBACK TO SAVEPOINT msum_refresh');await c.query("SELECT set_config('lock_timeout',$1,true)",[prev]);return 'raced';}
    const by=(rows:Rows)=>{const m=new Map<string,unknown[]>();for(const r of rows){const l=m.get(r.member_id)??[];l.push(r.payload);m.set(r.member_id,l);}return m;};
    const V=by(visits),P=by(payments),I=by(invoices);
    for(const id of todo){
      const m=members.get(id)!;
      const local={members:[m],visits:V.get(id)??[],payments:P.get(id)??[],invoices:I.get(id)??[]} as unknown as GymState;
      const s=computeStoredSummary(local,m,effective);
      await c.query('INSERT INTO gymos.gym_member_summaries(owner_id,member_id,stored) VALUES($1,$2,$3) ON CONFLICT(owner_id,member_id) DO UPDATE SET stored=EXCLUDED.stored',[owner,id,JSON.stringify(s)]);
      // Rows read above are at least as new as the marks read under the lock; a later writer leaves a newer gen and the member stays dirty.
      if(gens.has(id))await c.query('DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 AND member_id=$2 AND gen=$3',[owner,id,gens.get(id)]);
      out.set(id,{member:m,stored:s});
    }
    await c.query('RELEASE SAVEPOINT msum_refresh');await c.query("SELECT set_config('lock_timeout',$1,true)",[prev]);
    return null;
  }catch(e){
    if(busy(e)){await c.query('ROLLBACK TO SAVEPOINT msum_refresh');await c.query("SELECT set_config('lock_timeout',$1,true)",[prev]);return 'busy';}
    throw e;
  }
}

async function ready(c:Sql,owner:string){
  if(!(await c.query("SELECT to_regclass('gymos.gym_member_summaries') IS NOT NULL AND to_regclass('gymos.gym_member_summary_ready') IS NOT NULL AS ok")).rows.some(r=>(r as {ok:boolean}).ok))return false;
  return (await c.query('SELECT 1 FROM gymos.gym_member_summary_ready WHERE owner_id=$1',[owner])).rows.length>0;
}

/** Candidates for the members screen. Read-only unless the caller passes refresh:true (request-side writes are explicit): without it, any dirty or
 * missing member returns 'stale' and nothing is written. */
export async function readMemberCandidates(c:Sql,owner:string,branches:string[]|null,opts:{refresh?:boolean;now?:string;photo?:boolean;maxDirty?:number}={}):Promise<CandidateResult>{
  if(!await ready(c,owner))return refuse('unready');
  const filter=branches?' AND e.branch=ANY($2::text[])':'';const args=branches?[owner,branches]:[owner];
  // ONE statement: each member payload, its stored inputs and its dirty mark come from the same snapshot, so a candidate is never an old member paired with newer inputs.
  const photoSql=opts.photo===false?'NULL::text':"CASE WHEN NULLIF(e.payload->>'photo','') IS NOT NULL THEN left(encode(sha256(convert_to(e.payload->>'photo','UTF8')),'hex'),16) ELSE (SELECT left(encode(sha256(convert_to(ph.content,'UTF8')),'hex'),16) FROM gymos.gym_photos ph WHERE ph.owner_id=e.owner_id AND ph.member_id=e.entity_id) END";
  const rows=(await c.query(`SELECT e.entity_id,e.payload-'photo'-'health'-'vitals'-'measurements' AS payload,${photoSql} AS photo_v,s.stored,d.gen FROM gymos.gym_entities e LEFT JOIN gymos.gym_member_summaries s ON s.owner_id=e.owner_id AND s.member_id=e.entity_id LEFT JOIN gymos.gym_member_summary_dirty d ON d.owner_id=e.owner_id AND d.member_id=e.entity_id WHERE e.owner_id=$1 AND e.collection='members'${filter} ORDER BY e.position,e.entity_id LIMIT ${MEMBER_CANDIDATE_MAX+1}`,args)).rows as {entity_id:string;payload:Member;photo_v:string|null;stored:StoredSummary|null;gen:string|number|null}[];
  if(rows.length>MEMBER_CANDIDATE_MAX)return refuse('too-many-members');
  const members=rows.filter(r=>!r.payload.archived);
  const need=members.filter(r=>r.gen!==null||!r.stored||r.stored.v!==2).map(r=>r.entity_id); // a missing row is never trusted
  if(need.length>Math.min(opts.maxDirty??REFRESH_MAX,REFRESH_MAX))return refuse('too-many-dirty');
  const fresh=new Map<string,Candidate>();
  if(need.length){
    if(!opts.refresh)return refuse('stale');
    const why=await recompute(c,owner,need,fresh,opts.now);if(why)return refuse(why);
  }
  const needSet=new Set(need),candidates:Candidate[]=[];
  for(const r of members){if(!needSet.has(r.entity_id))candidates.push({member:r.payload,stored:r.stored!,photoV:r.photo_v});else{const f=fresh.get(r.entity_id);if(!f)return refuse('raced');candidates.push({member:slim(f.member),stored:f.stored,photoV:r.photo_v});}} // absent: deleted while refreshing
  return{status:'ok',candidates,refreshed:need.length};
}

/** Bounded refresher for the (separately gated) backfill and for mass-dirty events such as a restore: recomputes up to `max` dirty members under one bound check and
 * one lock, and reports how many marks are left. Also forgets marks and rows of deleted members. */
export async function refreshDirtySummaries(c:Sql,owner:string,max=REFRESH_MAX,asOf?:string,branch?:string):Promise<RefreshResult>{
  if(!await ready(c,owner))return refuse('unready');
  // Bounded waves only: each call recomputes at most `max` (<= REFRESH_MAX) dirty members by per-member index lookups; callers loop until remaining is 0.
  // `branch` (optional) scopes BOTH the members recomputed and the `remaining` count to that branch's members (a restricted caller never writes or waits on another branch's marks).
  const sel=branch===undefined?'SELECT member_id FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 ORDER BY gen LIMIT $2':"SELECT d.member_id FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id AND e.branch=$3 WHERE d.owner_id=$1 ORDER BY d.gen LIMIT $2";
  const ids=(await c.query(sel,branch===undefined?[owner,Math.min(max,REFRESH_MAX)]:[owner,Math.min(max,REFRESH_MAX),branch])).rows.map(r=>(r as {member_id:string}).member_id);
  const out=new Map<string,Candidate>();const why=await recompute(c,owner,ids,out,asOf);if(why)return refuse(why);
  const cnt=branch===undefined?['SELECT count(*) AS n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1',[owner]] as const:["SELECT count(*) AS n FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id AND e.branch=$2 WHERE d.owner_id=$1",[owner,branch]] as const;
  const left=Number((await c.query(cnt[0],[...cnt[1]])).rows[0]?.['n' as never]??0);
  return{status:'ok',refreshed:ids.length,remaining:left};
}

export type DrainResult={status:'ok';refreshed:number;more:boolean;batches:number}|{status:Refusal};
/** Request-side bounded drain for ONE branch: ONE selection of up to budget+1 dirty members of that branch (so `more` is exact without counting the backlog and without re-scanning per batch),
 * then recomputed in units of `batch` until the budget is spent or `deadlineAt` (epoch ms) has passed. The deadline is checked before every unit, so the overrun is at most one unit.
 * Marks of members that no longer exist are not selected (the membership join excludes them): they are not this caller's work and are cleaned by the owner-wide refresher only. */
export async function drainBranchDirty(c:Sql,owner:string,branch:string,o:{budget:number;batch:number;deadlineAt:number;asOf?:string}):Promise<DrainResult>{
  if(!await ready(c,owner))return refuse('unready');
  const budget=Math.max(0,Math.min(o.budget,REFRESH_MAX)),batch=Math.max(1,o.batch);
  const ids=(await c.query("SELECT d.member_id FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id AND e.branch=$3 WHERE d.owner_id=$1 ORDER BY d.gen LIMIT $2",[owner,budget+1,branch])).rows.map(r=>(r as {member_id:string}).member_id);
  const work=ids.slice(0,budget);let done=0,batches=0;
  while(done<work.length&&Date.now()<o.deadlineAt){
    const unit=work.slice(done,done+batch);const why=await recompute(c,owner,unit,new Map<string,Candidate>(),o.asOf);if(why)return refuse(why);
    done+=unit.length;batches++;
  }
  return{status:'ok',refreshed:done,more:ids.length>done,batches};
}

/** Convenience for the (future, not yet wired) route: one consistent REPEATABLE READ snapshot for the whole candidate read and refresh. */
export async function readMemberCandidatesSnapshot(owner:string,branches:string[]|null,opts:{refresh?:boolean;now?:string}={}):Promise<CandidateResult>{
  const {withSnapshotScope}=await import('./member-summary-scope.ts');
  return withSnapshotScope(owner,c=>readMemberCandidates(c,owner,branches,opts));
}

/** The owner's change version (see migration 20261121190000): strictly increasing across every writer. null when the migration is absent or the owner has no token
 * (after a TRUNCATE): such a token never matches a cache entry. */
export async function readOwnerVersion(c:Sql,owner:string):Promise<string|null>{
  if(!(await c.query("SELECT to_regclass('gymos.gym_owner_version') IS NOT NULL AS ok")).rows.some(r=>(r as {ok:boolean}).ok))return null;
  const r=(await c.query('SELECT version FROM gymos.gym_owner_version WHERE owner_id=$1',[owner])).rows[0] as {version:string|number}|undefined;
  return r?String(r.version):null;
}

/** Headline total of the Operations dues tab for a whole branch from the maintained per-member summaries instead of scanning every invoice and allocation.
 *  Exact or null: null (caller runs the exact scan) unless the owner is ready, every dirty member was refreshed, every summary carries finite dues, and the invoice count the
 *  summaries saw for this branch equals the branch's real invoice count (invoices of deleted/unknown members make them differ). */
export async function branchDuesTotal(c:Sql,owner:string,branch:string,diag?:{gap?:number}):Promise<number|null>{
  if(!await ready(c,owner))return null;
  if(Number(((await c.query('SELECT count(*) AS n FROM (SELECT 1 FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 LIMIT $2) x',[owner,2*REFRESH_MAX+1])).rows[0] as {n:string}).n)>2*REFRESH_MAX)return null; // cold backfill or a heavy write burst: refresh waves would be thrown away next to the scan, so the caller scans directly and the background drain catches up
  for(let wave=0;wave<3;wave++){const r=await refreshDirtySummaries(c,owner);if(r.status!=='ok')return null;if(r.remaining===0)break;if(wave===2)return null;}
  const r=(await c.query("SELECT count(*) FILTER (WHERE stored->'dues' IS NULL) AS nodues,count(*) FILTER (WHERE stored->'dues'->$2 IS NOT NULL AND (jsonb_typeof(stored->'dues'->$2->'sum')<>'number' OR stored->'dues'->$2->>'odd'='true')) AS bad,COALESCE(sum((stored->'dues'->$2->>'n')::int),0) AS n,COALESCE(sum((stored->'dues'->$2->>'sum')::numeric),0)::text AS total FROM gymos.gym_member_summaries WHERE owner_id=$1",[owner,branch])).rows[0] as {nodues:string;bad:string;n:string;total:string};
  const inv=Number(((await c.query("SELECT count(*) AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection='invoices' AND branch=$2",[owner,branch])).rows[0] as {n:string}).n);
  const dirty=Number(((await c.query('SELECT count(*) AS n FROM gymos.gym_member_summary_dirty WHERE owner_id=$1',[owner])).rows[0] as {n:string}).n);
  if(Number(r.n)!==inv&&dirty===0&&diag)diag.gap=inv-Number(r.n); // invoices no member summary accounts for (no member key): the exact scan runs and the gap is reported, not hidden
  if(dirty!==0||Number(r.nodues)!==0||Number(r.bad)!==0||Number(r.n)!==inv)return null;
  const total=Number(r.total);return Number.isFinite(total)?total:null;
}
