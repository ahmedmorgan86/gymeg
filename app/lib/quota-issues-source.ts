// Default-off aggregate for the Overview active count, membership ring and member status: WHICH members of one branch have a quota issue today.
// It exists because the packet may omit visits, and membershipIssue()'s quota branch is the only part that reads them (every other branch reads the member row).
// Scope of the claim (evidence: tests/member-summary-store.integration.mjs tests 16-17 and tests/quota-issues-source.integration.mjs): ISSUE classification only, same-branch visits,
// never numeric used/visitsRemaining. Anything not derivable exactly from the stored summaries is {status:'fallback'}; the client then shows unknown, never a plausible total.
import {readMemberCandidates,readOwnerVersion} from './member-summary-store.ts';
import {deriveSummary} from './member-summary-model.ts';
import {dayAt} from './domain.ts';
import type {GymState} from './domain.ts';
import type {Scope} from './member-console-source.ts';
export type QuotaIssues={status:'ok';version:string;day:string;quota:string[];members:number}|{status:'unchanged';version:string}|{status:'fallback';reason:string}|{status:'forbidden'};
export type QuotaRequest={owner:string;branch:string;branches:string[]|null;settings:GymState['settings'];now:string;since?:string|null};
export async function readQuotaIssues(scope:Scope,q:QuotaRequest):Promise<QuotaIssues>{
  if(!q.branch||q.branch.length>200)return{status:'fallback',reason:'invalid-branch'};
  if(q.branches&&!q.branches.includes(q.branch))return{status:'forbidden'};
  return scope(q.owner,async c=>{
    const v1=await readOwnerVersion(c,q.owner);if(v1===null)return{status:'fallback',reason:'no-version'} as const;
    const day=dayAt(q.now,q.settings.timezone);
    if(q.since&&q.since===v1+'|'+day)return{status:'unchanged',version:v1} as const; // the token covers the day too: a day change must recompute
    const r=await readMemberCandidates(c,q.owner,[q.branch],{refresh:true,now:q.now});
    if(r.status!=='ok')return{status:'fallback',reason:r.status} as const;
    const quota:string[]=[];
    for(const {member,stored} of r.candidates){
      const x=deriveSummary(stored,member,q.settings,q.now);
      if(x===null)return{status:'fallback',reason:'null-derivation'} as const; // explicit: full state is needed for this member; the caller keeps unknown
      if(x.issue==='quota')quota.push(member.id);
    }
    if((await readOwnerVersion(c,q.owner))!==v1)return{status:'fallback',reason:'changed-during-read'} as const;
    return{status:'ok',version:v1+'|'+day,day,quota,members:r.candidates.length} as const;
  });
}
