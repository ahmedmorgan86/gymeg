import {membershipIssue} from './extensions';
import {membershipPeriods} from './membership-periods';
import type {GymState,Member} from './domain';
/** Overview issue for one member. OFF -> legacy over the packet. ON with the server set -> non-quota issues from the member row plus the set.
 * ON without the set: non-strict -> legacy over the packet visits (never a wrong Active); strict -> 'unknown' for a visit-limited member with no other issue. */
export function composeIssue(s:GymState,m:Member,day:string,on:boolean,set:Set<string>|null,strict:boolean):string|null{
  if(!on||(!set&&!strict))return membershipIssue(s,m,day);
  const base=membershipIssue({...s,visits:[]},m,day);if(base!==null)return base;
  if(set)return set.has(m.id)?'quota':null;
  return !m.archived&&membershipPeriods(m).some((p:{visits?:number|null})=>p.visits!=null)?'unknown':null;
}
