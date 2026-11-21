// Hydration plans for a few hot operations. A plan lists exactly which rows
// applyOperation needs; everything else is left out. A plan is only trusted
// after tests/hot-ops-differential.test.mjs shows the same outcome as the full
// state. Operations without a plan return null and keep the full read.
import type {GymState,Operation} from './domain.ts';

export type HotPlan={
  /** Branch whose plans and shifts are loaded (open visits are club-wide). */
  branch:string;
  /** Member whose rows are loaded (members, visits, payments, invoices). */
  member?:string;
  /** Visit id whose member is resolved first (visit.exit). */
  visit?:string;
};
export const HOT_OPERATIONS=['payment.add','visit.add','visit.exit'] as const;
export function hotPlan(op:Operation):HotPlan|null{
  if(typeof op.branch!=='string')return null;
  if(op.type==='payment.add'||op.type==='visit.add')return typeof op.id==='string'?{branch:op.branch,member:op.id}:null;
  if(op.type==='visit.exit')return typeof op.id==='string'?{branch:op.branch,visit:op.id}:null;
  return null;
}
/** Test/reference hydration over an in-memory full state. The SQL version in the slice reader must select the same rows. */
export function partialState(full:GymState,plan:HotPlan):GymState{
  const member=plan.member??full.visits.find(v=>v.id===plan.visit&&v.branch===plan.branch)?.member;
  const s=structuredClone(full) as GymState;
  const keep=<T>(rows:T[]|undefined,f:(x:T)=>boolean)=>(rows??[]).filter(f);
  const mine=(x:{member:string})=>x.member===member; // any branch: debt and quota logic read the member's rows across branches
  s.members=keep(s.members,m=>m.id===member&&m.branch===plan.branch);
  s.visits=keep(s.visits,v=>v.member===member||!v.leftAt); // member history + every open visit: closeExpiredVisits sweeps all branches
  s.payments=keep(s.payments,p=>mine(p));
  s.invoices=keep(s.invoices,i=>mine(i));
  s.plans=keep(s.plans,p=>p.branch===plan.branch);
  s.shifts=keep(s.shifts,x=>x.branch===plan.branch);
  for(const c of ['classes','pulse','events','receipts','announcements','products','stockLots','shopSales','followUps','programs','trainingAssignments','trainingSessions','coaching','coaches','coachOffers','coachPayouts','cashClosures','suppliers'] as const)(s as Record<string,unknown>)[c]=[];
  return s;
}
