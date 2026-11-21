// Client-side list layer over stored member summaries (held, unwired). It rebuilds what consoleIndex(state,branch,now) gives the members screen (member row,
// the summary fields the list reads, and the exact search string) from small candidates instead of the full visits/payments/invoices. Anything it cannot answer
// exactly returns {status:'fallback'} and the caller keeps the legacy full-state path: there is no approximation.
import type {GymState,Member} from './domain.ts';
import {consoleSearch} from './member-console.ts';
import {deriveSummary,type StoredSummary} from './member-summary-model.ts';

export type ConsoleCandidate={member:Member;stored:StoredSummary};
export type ListContext={settings:GymState['settings'];plans?:GymState['plans']};
type Derived=NonNullable<ReturnType<typeof deriveSummary>>;
/** Same fields as memberSummary() except `invoices` (detail only) and `plan` is looked up from the club plans. */
export type ListSummary=Derived&{plan:NonNullable<GymState['plans']>[number]|undefined};
export type ListRow={m:Member;summary:ListSummary;search:string};
export type ListResult={status:'ok';rows:ListRow[]}|{status:'fallback';reason:'horizon-or-period-totals'|'stored-version'};

export function consoleIndexFromCandidates(cands:ConsoleCandidate[],ctx:ListContext,branch:string,now:string):ListResult{
  const rows:ListRow[]=[];
  for(const {member:m,stored} of cands){
    if(m.branch!==branch||m.archived)continue;
    if(stored.v!==2)return{status:'fallback',reason:'stored-version'};
    const d=deriveSummary(stored,m,ctx.settings,now);
    if(!d)return{status:'fallback',reason:'horizon-or-period-totals'};
    const summary={...d,plan:ctx.plans?.find(p=>p.id===d.period?.plan)} as ListSummary;
    // consoleSearch reads only the member and the summary when the summary is supplied, so no state is needed here.
    rows.push({m,summary,search:consoleSearch(undefined as unknown as GymState,m,now,summary as never)});
  }
  return{status:'ok',rows};
}

/** Revision-aware cache for a candidate set. A hit requires the SAME owner, branch and workspace revision; any other revision is a miss and the set is refetched.
 * It never serves a set across revisions, so list data cannot be older than the revision the page was told about. */
export class CandidateCache{
  private entry:{owner:string;branch:string;revision:number;cands:ConsoleCandidate[]}|null=null;
  get(owner:string,branch:string,revision:number){const e=this.entry;return e&&e.owner===owner&&e.branch===branch&&e.revision===revision?e.cands:null;}
  put(owner:string,branch:string,revision:number,cands:ConsoleCandidate[]){this.entry={owner,branch,revision,cands};}
  clear(){this.entry=null;}
}
