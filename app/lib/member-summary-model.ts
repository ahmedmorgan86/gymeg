// Prototype: a per-member summary that can be stored with the member row and
// still reproduce memberSummary() exactly at any later clock time.
// computeStoredSummary() holds only time-independent inputs (recomputed when the
// member, their visits, payments or invoices change). deriveSummary() applies
// the clock, the policy and the timezone at read time. No schema is applied and
// nothing reads this in production yet.
import {dayAt,days,type GymState,type Member} from './domain.ts';
import {membershipPeriod,membershipPeriods} from './membership-periods.ts';
import {debt,receptionPolicy} from './member-console.ts';

/** [day, periodId|null, units (sessions+1), sameBranchAsMember 0|1] */
export type UsageTuple=[string,string|null,number,0|1];
export type StoredSummary={
  v:1;
  visitCount:number;
  /** Only visits that can count toward one of the member's non-cancelled periods. */
  usage:UsageTuple[];
  open:{id:string;at:string;activeAt?:string}[];
  last:{id:string;at:string}|null;
  debt:number;
  paid:number;
};
type Row=Pick<GymState,'visits'|'payments'|'invoices'>;

export function computeStoredSummary(s:GymState,m:Member):StoredSummary{
  const visits=s.visits.filter(v=>v.member===m.id);
  const periods=membershipPeriods(m).filter(p=>!p.cancelled);
  const ids=new Set(periods.map(p=>p.id));
  const relevant=(v:typeof visits[number])=>v.periodId?ids.has(v.periodId):periods.some(p=>v.day>=p.start&&v.day<=p.end);
  const last=visits.slice().sort((a,b)=>b.at.localeCompare(a.at))[0];
  return{
    v:1,
    visitCount:visits.length,
    usage:visits.filter(relevant).map(v=>[v.day,v.periodId??null,(v.sessions?.length??0)+1,v.branch===m.branch?1:0] as UsageTuple),
    open:visits.filter(v=>!v.leftAt).map(v=>({id:v.id,at:v.at,activeAt:v.activeAt})),
    last:last?{id:last.id,at:last.at}:null,
    debt:debt(s as GymState,m.id),
    paid:s.payments.filter(p=>p.member===m.id&&!p.voided).reduce((n,p)=>n+p.minor,0),
  };
}

export function deriveSummary(stored:StoredSummary,m:Member,settings:GymState['settings'],now:string){
  const policy=receptionPolicy({settings} as GymState);
  const today=dayAt(now,settings.timezone),period=membershipPeriod(m,today);
  const current=stored.open.find(v=>Date.parse(v.activeAt??v.at)+policy.autoExitMinutes*60000>Date.parse(now));
  const units=(t:UsageTuple)=>period&&period.quotaMode==='sessions'?t[2]:1; // sessions mode counts every session, otherwise one per visit
  const inPeriod=(t:UsageTuple)=>t[1]?t[1]===period!.id:t[0]>=period!.start&&t[0]<=period!.end;
  // memberSummary().used: this period's visits (any branch), or every visit when there is no period.
  const used=period?stored.usage.filter(inPeriod).reduce((n,t)=>n+units(t),0):stored.visitCount;
  let issue:string|null=null;
  if(m.awaitingSubscription)issue='inactive';
  else if(membershipPeriods(m).length&&!period)issue='inactive';
  else if(m.archived||m.joined>today||m.expires<today)issue='inactive';
  else if(m.freezes?.some(f=>!f.cancelled&&f.from<=today&&f.to>=today))issue='frozen';
  else if(period?.visits!=null&&stored.usage.filter(t=>t[3]===1&&inPeriod(t)&&t[0]<=today).reduce((n,t)=>n+units(t),0)>=period.visits)issue='quota';
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
export function backfillSummaries(s:GymState):Map<string,StoredSummary>{
  const group=<T extends {member:string}>(rows:T[]|undefined)=>{const g=new Map<string,T[]>();for(const r of rows??[]){const a=g.get(r.member);if(a)a.push(r);else g.set(r.member,[r]);}return g;};
  const v=group(s.visits),p=group(s.payments),i=group(s.invoices),out=new Map<string,StoredSummary>();
  for(const m of s.members)out.set(m.id,computeStoredSummary({...s,visits:v.get(m.id)??[],payments:p.get(m.id)??[],invoices:i.get(m.id)??[]} as GymState,m));
  return out;
}
