// Prototype: a per-member summary that can be stored with the member row and
// still reproduce memberSummary() exactly at any later clock time.
// computeStoredSummary() holds only time-independent inputs (recomputed when the
// member, their visits, payments or invoices change). deriveSummary() applies
// the clock, the policy and the timezone at read time. No schema is applied and
// nothing reads this in production yet.
import {dayAt,days,type GymState,type Member} from './domain.ts';
import {membershipPeriod,membershipPeriods} from './membership-periods.ts';
import {debt,receptionPolicy} from './member-console.ts';
import {invoiceOutstanding} from './member-ledger.ts';

/** [day, periodId|null, units (sessions+1), sameBranchAsMember 0|1] */
export type UsageTuple=[string,string|null,number,0|1];
/** Per-period totals over visits dated on or before the horizon: n visits, u units (sessions+1 each), sn/su the same two counted for visits at the member's own branch. */
export type PeriodTotals={n:number;u:number;sn:number;su:number};
/** The LISTING projection (v2). Size is O(periods + open visits + visits dated after the horizon), never O(history): the per-visit usage list of v1 is gone.
 * `horizon` is a calendar day that is at or before "today" in every timezone at the moment of computing. Visits dated on or before it are folded into the per-period
 * totals (a visit that old is always <= today at any later read, so the quota rule `day<=today` holds for the whole total). Visits dated after it are kept verbatim in
 * `tail` and judged one by one at read time. A read whose today is BEFORE the horizon (clock moved back, test clock) cannot be answered exactly: deriveSummary
 * returns null and the caller takes the exact full path for that member. */
export type StoredSummary={
  v:2;
  horizon:string;
  visitCount:number;
  periods:Record<string,PeriodTotals>;
  tail:UsageTuple[];
  open:{id:string;at:string;activeAt?:string}[];
  last:{id:string;at:string}|null;
  debt:number;
  paid:number;
  /** Per INVOICE branch: sum of the legacy invoiceOutstanding() over the member's invoices there (all branches) and their count. sum is null when any value is not finite, so readers fall back to the exact scan instead of trusting it. Feeds the Operations dues headline total. */
  dues:Record<string,{sum:number|null;n:number;odd?:boolean}>;
};
type Row=Pick<GymState,'visits'|'payments'|'invoices'>;
const dayBefore=(iso:string)=>new Date(Date.parse(iso.slice(0,10)+'T00:00:00.000Z')-86400000).toISOString().slice(0,10);

/** `asOf` is the compute clock (default: now). It only chooses the horizon; everything else is time-independent. */
/** The console only ever shows a member the rows recorded at the MEMBER'S OWN branch (consoleIndex partitions visits, payments and invoices by branch === the member's
 * branch). The projection reproduces exactly that view: rows at other branches are ignored, including for debt (an allocation to a payment at another branch finds no
 * payment, as in consoleIndex) and for the last visit. */
export function localView(s:GymState,m:Member):GymState{
  return{...s,members:[m],visits:s.visits.filter(v=>v.member===m.id&&v.branch===m.branch),payments:s.payments.filter(p=>p.member===m.id&&p.branch===m.branch),invoices:(s.invoices??[]).filter(i=>i.member===m.id&&i.branch===m.branch)} as GymState;
}
/** `allBranches` is the member DETAIL view: memberSummary(packetState,m) counts the member's rows at every branch the caller can see (the list uses localView). */
/** Per invoice-branch outstanding of one member, with the application's own arithmetic over the packet-shaped member rows. */
export function memberDues(full:GymState,m:Member):StoredSummary['dues']{
  const st={...full,payments:full.payments.filter(p=>p.member===m.id),invoices:(full.invoices??[]).filter(i=>i.member===m.id)} as GymState;
  const out:StoredSummary['dues']={};
  for(const i of st.invoices??[]){const o=invoiceOutstanding(st,i),cur=out[i.branch]??{sum:0,n:0};cur.n++;if(!(i.voided===undefined||typeof i.voided==='boolean')||typeof i.total!=='number'||!Array.isArray(i.allocations)||i.allocations.some(a=>typeof a.minor!=='number'))cur.odd=true;cur.sum=cur.sum===null||!Number.isFinite(o)?null:cur.sum+o;out[i.branch]=cur;}
  return out;
}
export function computeStoredSummary(full:GymState,m:Member,asOf:string=new Date().toISOString(),opts?:{allBranches?:boolean}):StoredSummary{
  const s=opts?.allBranches?{...full,members:[m],visits:full.visits.filter(v=>v.member===m.id),payments:full.payments.filter(p=>p.member===m.id),invoices:(full.invoices??[]).filter(i=>i.member===m.id)} as GymState:localView(full,m);
  const horizon=dayBefore(asOf);
  const visits=s.visits.filter(v=>v.member===m.id);
  const periods=membershipPeriods(m).filter(p=>!p.cancelled);
  const ids=new Set(periods.map(p=>p.id));
  const relevant=(v:typeof visits[number])=>v.periodId?ids.has(v.periodId):periods.some(p=>v.day>=p.start&&v.day<=p.end);
  const last=visits.slice().sort((a,b)=>b.at.localeCompare(a.at))[0];
  const totals:Record<string,PeriodTotals>={};
  for(const p of periods)totals[p.id]={n:0,u:0,sn:0,su:0};
  const tail:UsageTuple[]=[];
  for(const v of visits){
    if(!relevant(v))continue;
    const units=(v.sessions?.length??0)+1,same=v.branch===m.branch?1:0;
    if(v.day>horizon){tail.push([v.day,v.periodId??null,units,same as 0|1]);continue;}
    for(const p of periods){
      if(!(v.periodId?v.periodId===p.id:v.day>=p.start&&v.day<=p.end))continue;
      const t=totals[p.id];t.n++;t.u+=units;if(same){t.sn++;t.su+=units;}
    }
  }
  return{
    v:2,horizon,
    visitCount:visits.length,
    periods:totals,
    tail,
    open:visits.filter(v=>!v.leftAt).map(v=>({id:v.id,at:v.at,activeAt:v.activeAt})),
    last:last?{id:last.id,at:last.at}:null,
    debt:debt(s as GymState,m.id),
    paid:s.payments.filter(p=>p.member===m.id&&!p.voided).reduce((n,p)=>n+p.minor,0),
    dues:memberDues(full,m),
  };
}

/** Exact equivalent of memberSummary() at `now`, or null when the stored projection cannot answer exactly (today before the horizon, or a period without totals). */
export function deriveSummary(stored:StoredSummary,m:Member,settings:GymState['settings'],now:string){
  const policy=receptionPolicy({settings} as GymState);
  const today=dayAt(now,settings.timezone),period=membershipPeriod(m,today);
  if(stored.v!==2||today<stored.horizon)return null;
  const totals=period?stored.periods[period.id]:undefined;
  if(period&&!totals)return null;
  const current=stored.open.find(v=>Date.parse(v.activeAt??v.at)+policy.autoExitMinutes*60000>Date.parse(now));
  const sessions=!!period&&period.quotaMode==='sessions';
  const units=(t:UsageTuple)=>sessions?t[2]:1; // sessions mode counts every session, otherwise one per visit
  const inPeriod=(t:UsageTuple)=>t[1]?t[1]===period!.id:t[0]>=period!.start&&t[0]<=period!.end;
  // memberSummary().used: this period's visits (any branch), or every visit when there is no period.
  const used=period?(sessions?totals!.u:totals!.n)+stored.tail.filter(inPeriod).reduce((n,t)=>n+units(t),0):stored.visitCount;
  let issue:string|null=null;
  if(m.awaitingSubscription)issue='inactive';
  else if(membershipPeriods(m).length&&!period)issue='inactive';
  else if(m.archived||m.joined>today||m.expires<today)issue='inactive';
  else if(m.freezes?.some(f=>!f.cancelled&&f.from<=today&&f.to>=today))issue='frozen';
  else if(period?.visits!=null&&(sessions?totals!.su:totals!.sn)+stored.tail.filter(t=>t[3]===1&&inPeriod(t)&&t[0]<=today).reduce((n,t)=>n+units(t),0)>=period.visits)issue='quota';
  const remaining=days(today,period?.end??m.expires);
  return{
    period,current,issue,remaining,debt:stored.debt,
    status:issue?'expired' as const:remaining<=policy.warningDays?'warning' as const:'active' as const,
    used,visitsRemaining:period?.visits==null?null:Math.max(0,period.visits-used),
    paid:stored.paid,last:stored.last,
  };
}
export type {Row};

/**
 * Pure backfill: one grouping pass over visits, payments and invoices, then a
 * per-member compute on that member's rows only (O(rows), not members x rows).
 * Debt only looks at a member's own payments, so the per-member view is exact.
 */
export function backfillSummaries(s:GymState,asOf?:string):Map<string,StoredSummary>{
  const group=<T extends {member:string}>(rows:T[]|undefined)=>{const g=new Map<string,T[]>();for(const r of rows??[]){const a=g.get(r.member);if(a)a.push(r);else g.set(r.member,[r]);}return g;};
  const v=group(s.visits),p=group(s.payments),i=group(s.invoices),out=new Map<string,StoredSummary>();
  for(const m of s.members)out.set(m.id,computeStoredSummary({...s,visits:v.get(m.id)??[],payments:p.get(m.id)??[],invoices:i.get(m.id)??[]} as GymState,m,asOf));
  return out;
}

/** The stored projection WITHOUT the internal dues sums. dues are per invoice-branch totals across every branch of a member and exist only for the server-side dues aggregate; they must never reach a listing or detail DTO (reception and branch-limited staff would see finance and foreign-branch figures). */
export function publicStored(stored:StoredSummary):StoredSummary{const {dues:_dues,...rest}=stored as StoredSummary&{dues?:unknown};void _dues;return {...rest,dues:{}} as StoredSummary;}
