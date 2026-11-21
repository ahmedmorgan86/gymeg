// Server side of the (OFF by default) member-console candidate source. Pure over an injected owner scope so it is testable without Next.
// Exactness rules: candidates come from the stored summary inputs through readMemberCandidates; ANYTHING it cannot serve exactly (unready owner, too many dirty
// members, state over the byte bound, busy, raced, stale) is answered as {status:'fallback'} so the client keeps the legacy full-state list. Never empty, never an error.
import {readMemberCandidates,readOwnerVersion} from './member-summary-store.ts';
import type {Member} from './domain.ts';
import type {StoredSummary} from './member-summary-model.ts';

export type Scope=<T>(owner:string,work:(c:{query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>})=>Promise<T>)=>Promise<T>;
export type CandidatesRequest={owner:string;branch:string;branches:string[]|null;financial:boolean;since?:string|null;now?:string};
export type CandidatesResponse=
  |{status:'ok';version:string;candidates:{member:Member;stored:StoredSummary}[]}
  |{status:'unchanged';version:string}
  |{status:'fallback';reason:string}
  |{status:'forbidden'};

/** `branches` is the caller's branch scope (null = all). `financial` is false for a reception user whose packet carries no payments/invoices: the packet-based
 * list then shows zero debt and zero paid, so the stored totals are blanked to match instead of leaking finance the packet withholds. */
export async function readConsoleCandidates(scope:Scope,q:CandidatesRequest):Promise<CandidatesResponse>{
  if(!q.branch||q.branch.length>200)return{status:'fallback',reason:'invalid-branch'};
  if(q.branches&&!q.branches.includes(q.branch))return{status:'forbidden'};
  return scope(q.owner,async c=>{
    const v1=await readOwnerVersion(c,q.owner);
    if(v1===null)return{status:'fallback',reason:'no-version'} as const; // migration absent or token missing: never cache
    if(q.since!==undefined&&q.since!==null&&q.since===v1)return{status:'unchanged',version:v1} as const;
    const r=await readMemberCandidates(c,q.owner,[q.branch],{refresh:true,now:q.now});
    if(r.status!=='ok')return{status:'fallback',reason:r.status} as const;
    const v2=await readOwnerVersion(c,q.owner);
    if(v2!==v1)return{status:'fallback',reason:'changed-during-read'} as const; // a writer landed between the token read and the rows: the client retries or stays legacy
    const candidates=r.candidates.map(x=>q.financial?x:{member:x.member,stored:{...x.stored,debt:0,paid:0}});
    return{status:'ok',version:v1,candidates} as const;
  });
}
