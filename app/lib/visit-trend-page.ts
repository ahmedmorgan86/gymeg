// Bounded read for the Overview attendance pulse: visits per day of one branch over [from, to].
// Legacy (workspace.tsx Overview/TrendChart): weekVisits = visits.filter(day>=addDays(today,1-period)&&day<=today).length, prevWeek over [today+1-2*period, today-period], chart value per day = visits.filter(day===d).length
// (JS code-unit string compare). Here: one grouped index-only count over the canonical-day partial index with C-collated range predicates, transfer O(days) <= 2*PERIOD_MAX, never the visits themselves.
// The client derives week, previous week and chart values from `days` (a missing day is 0). Any visit of the branch with a non-canonical day or `at` (visit_odd) => 'unavailable' and the caller keeps the packet expression.
import {boundedRead,indexProbe} from './bounded-read.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import {addDays} from './domain.ts';
import type {Scope} from './member-console-source.ts';
export const TREND_PERIOD_MAX=3660; // input sanity for the chart period (the UI offers 7 and 14), not a data limit
export type VisitTrend={status:'ok';version:string;from:string;to:string;days:Record<string,number>}|{status:'stale'}|{status:'unavailable';reason?:string};
export async function readVisitTrend(scope:Scope,q:{owner:string;branch:string;today:string;period:number}):Promise<VisitTrend>{
  if(!q.branch||q.branch.length>200||!/^\d{4}-\d\d-\d\d$/.test(q.today)||!Number.isSafeInteger(q.period)||q.period<1||q.period>TREND_PERIOD_MAX)throw new RangeError('invalid');
  const from=addDays(q.today,1-2*q.period);
  return scope(q.owner,c=>boundedRead(c,q.owner,'visittrend\u0000'+q.branch+'\u0000'+q.today+'\u0000'+q.period,async()=>{
    const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable',reason:'no-version'} as const;
    const odd=(await indexProbe(c,()=>c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND branch=$2 AND visit_odd) AS x`,[q.owner,q.branch]))).rows[0] as {x:boolean};
    if(odd.x)return{status:'unavailable',reason:'non-canonical-visit'} as const;
    // predicates repeated verbatim for gym_entities_visit_day_count; plain C-collated column so the range is an Index Cond under FORCE RLS
    const rows=(await c.query(`SELECT demand_visit_day AS d,count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND demand_visit_day IS NOT NULL AND demand_visit_day >= ($3::text COLLATE "C") AND demand_visit_day <= ($4::text COLLATE "C") GROUP BY demand_visit_day`,[q.owner,q.branch,from,q.today])).rows as {d:string;n:number}[];
    if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
    return{status:'ok',version:ver,from,to:q.today,days:Object.fromEntries(rows.map(r=>[r.d,Number(r.n)]))} as const;
  },o=>o.status==='ok'));
}
