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
/** Everything the held quota depends on, as one unambiguous JSON string (arrays, never delimiter joins). Includes the packet's authoritative revision: a lazy/omit packet has NO visit rows, so a check-in
 * (or another station's write) is visible only as a revision change. Also: member membership fields, the branch's visit rows when the packet has them, and the settings timezone (the day itself is in the hook key).
 * Same revision and same content keeps the hold across no-op packet replacements (polls, unrelated sync); any change drops it and refetches once. */
export function quotaSignature(s:GymState,branch:string,revision?:number|string|null):string{
  return JSON.stringify([revision??null,s.settings?.timezone??null,
    s.members.filter(m=>m.branch===branch).map(m=>[m.id,!!m.awaitingSubscription,!!m.archived,m.joined,m.expires,m.freezes??null,m.membershipPeriods??m.contract??null]),
    (s.visits??[]).filter(v=>v.branch===branch).map(v=>[v.member,v.periodId??null,v.day,v.sessions?.length??0])]);
}
