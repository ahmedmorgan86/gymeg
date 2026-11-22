// Default-off aggregate for the Overview active count, membership ring and member status: WHICH members of one branch have a quota issue today.
// It exists because the packet may omit visits, and membershipIssue()'s quota branch is the only part that reads them (every other branch reads the member row).
// Scope of the claim (evidence: tests/member-summary-store.integration.mjs tests 16-17 and tests/quota-issues-source.integration.mjs): ISSUE classification only, same-branch visits,
// never numeric used/visitsRemaining. Anything not derivable exactly from the stored summaries is {status:'fallback'}; the client then shows unknown, never a plausible total.
import {readMemberCandidates,readOwnerVersion,refreshDirtySummaries} from './member-summary-store.ts';
import {deriveSummary} from './member-summary-model.ts';
import {dayAt} from './domain.ts';
import type {GymState} from './domain.ts';
import type {Scope} from './member-console-source.ts';
/** Read budget of one request: at most this many dirty members are recomputed (write-on-read) before the answer is an explicit fallback; photos are never hashed (the aggregate does not use photoV). */
export const QUOTA_MAX_DIRTY=100,QUOTA_BATCH=10,QUOTA_WAVE_MS=2500,QUOTA_STATEMENT_MS=4000;
export type QuotaIssues={status:'ok';version:string;day:string;quota:string[];members:number;recomputed:number}|{status:'unchanged';version:string}|{status:'fallback';reason:string;remaining?:number;recomputed?:number}|{status:'forbidden'};
export type QuotaRequest={owner:string;branch:string;branches:string[]|null;settings:GymState['settings'];now:string;since?:string|null};
export async function readQuotaIssues(scope:Scope,q:QuotaRequest):Promise<QuotaIssues>{
  if(!q.branch||q.branch.length>200)return{status:'fallback',reason:'invalid-branch'};
  if(q.branches&&!q.branches.includes(q.branch))return{status:'forbidden'};
  return scope(q.owner,async c=>{
    await c.query("SELECT set_config('statement_timeout',$1,true)",[String(QUOTA_STATEMENT_MS)]); // transaction-local: a slow plan fails closed to the fallback
    const v1=await readOwnerVersion(c,q.owner);if(v1===null)return{status:'fallback',reason:'no-version'} as const;
    const day=dayAt(q.now,q.settings.timezone);
    if(q.since&&q.since===v1+'|'+day)return{status:'unchanged',version:v1} as const; // the token covers the day too: a day change must recompute
    // Convergence with a wall-clock bound: the dirty backlog is drained in small batches (QUOTA_BATCH recomputes each, savepointed inside recompute) until the budget of QUOTA_MAX_DIRTY recomputes
    // or QUOTA_WAVE_MS elapsed. Progress commits with this transaction, so a large backlog drains over successive reads; a failure rolls the whole transaction back. Total work of one wave is also
    // bounded by the owner's state (recompute is refused above the state byte limit and each visit belongs to one member), whatever the history shape.
    const t0=Date.now();let left=1,done=0;
    while(left>0&&done<QUOTA_MAX_DIRTY&&Date.now()-t0<QUOTA_WAVE_MS){
      const w=await refreshDirtySummaries(c,q.owner,Math.min(QUOTA_BATCH,QUOTA_MAX_DIRTY-done),q.now,q.branch);
      if(w.status!=='ok')return{status:'fallback',reason:w.status} as const;
      done+=w.refreshed;left=w.remaining;if(w.refreshed===0)break;
    }
    if(left>0)return{status:'fallback',reason:'draining',remaining:left,recomputed:done} as const;
    const r=await readMemberCandidates(c,q.owner,[q.branch],{refresh:Date.now()-t0<QUOTA_WAVE_MS,now:q.now,photo:false,maxDirty:QUOTA_MAX_DIRTY-done});
    if(r.status!=='ok')return{status:'fallback',reason:r.status} as const;
    const quota:string[]=[];
    for(const {member,stored} of r.candidates){
      const x=deriveSummary(stored,member,q.settings,q.now);
      if(x===null)return{status:'fallback',reason:'null-derivation'} as const; // explicit: full state is needed for this member; the caller keeps unknown
      if(x.issue==='quota')quota.push(member.id);
    }
    if((await readOwnerVersion(c,q.owner))!==v1)return{status:'fallback',reason:'changed-during-read'} as const;
    return{status:'ok',version:v1+'|'+day,day,quota,members:r.candidates.length,recomputed:done+r.refreshed} as const;
  });
}
