import type {GymState} from './domain.ts';
/** Only newly confirmed, recent entries in the currently visible branch open a profile. */
export function checkinProfile(previous:GymState|null,next:GymState,branch:string,now:number):string|null{
 if(!previous||(previous.generation??'v1')!==(next.generation??'v1'))return null;
 const before=new Map(previous.visits.map(v=>[v.id,v.activeAt??v.at])),members=new Set(next.members.filter(m=>m.branch===branch&&!m.archived).map(m=>m.id));
 const entries=next.visits.filter(v=>v.branch===branch&&!v.leftAt&&before.get(v.id)!==(v.activeAt??v.at)&&Date.parse(v.activeAt??v.at)<=now+60000&&Date.parse(v.activeAt??v.at)>=now-120000&&members.has(v.member));
 entries.sort((a,b)=>Date.parse(b.activeAt??b.at)-Date.parse(a.activeAt??a.at));return entries[0]?.member??null;
}
export type OpenEntry={id:string;member:string;at:string;activeAt?:string};
const key=(v:OpenEntry)=>v.activeAt??v.at;
const inWindow=(v:OpenEntry,now:number)=>Date.parse(key(v))<=now+60000&&Date.parse(key(v))>=now-120000;
/** Same selection over an already-known set of OPEN visits of the branch (lazy open-visits read). `before` maps id -> activeAt??at of the previous successful read of the same scope (kept across
 * failed reads, so a check-in during a failed interval is still seen on the next success). `carry` = entries seen new earlier whose member was not yet in the packet's member list (a member
 * registered between the packet and the open read): they are re-evaluated against the current members, not lost.
 * Known, theoretical divergence from the packet comparison: legacy `before` also holds CLOSED visits, so a visit id that was closed and is open again with an unchanged activeAt/at is not new
 * there but is new here (ids are unique ULID-like and visits are never reopened by any operation). */
export function checkinPick(before:ReadonlyMap<string,string>|null,open:OpenEntry[],members:ReadonlySet<string>,now:number,carry:readonly OpenEntry[]=[]):{member:string|null;carry:OpenEntry[]}{
 if(!before)return{member:null,carry:[]};
 const openIds=new Set(open.map(v=>v.id)),fresh=open.filter(v=>before.get(v.id)!==key(v)),cands=[...fresh,...carry.filter(c=>openIds.has(c.id)&&!fresh.some(f=>f.id===c.id))].filter(v=>inWindow(v,now));
 const chosen=cands.filter(v=>members.has(v.member));chosen.sort((a,b)=>Date.parse(key(b))-Date.parse(key(a)));
 return{member:chosen[0]?.member??null,carry:cands.filter(v=>!members.has(v.member))};
}
export function checkinProfileFromOpen(before:ReadonlyMap<string,string>|null,open:OpenEntry[],members:ReadonlySet<string>,now:number):string|null{return checkinPick(before,open,members,now).member;}
/** Server clock now, grounded on the packet's serverNow plus the local time elapsed since that packet was received (a delayed or retried read must not use the packet's frozen clock). */
export function openNow(serverNow:number|undefined,receivedAt:number,localNow:number):number{return(serverNow??receivedAt)+(localNow-receivedAt);}
/** The map remembered for the next comparison: entries activated AFTER now+60s are left out so they still count as new once the window reaches them (never consumed unseen). */
export function consumedMap(open:OpenEntry[],now:number):Map<string,string>{return new Map(open.filter(v=>Date.parse(key(v))<=now+60000).map(v=>[v.id,key(v)]));}
