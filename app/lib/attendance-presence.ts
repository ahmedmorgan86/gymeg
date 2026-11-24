import {receptionPolicy} from './member-console.ts';
import type {GymState,Visit} from './domain.ts';
import {presentVisits} from './member-view.ts';

/** Visits store previous completed sessions plus the current/last session. */
export function visitTiming(visit:Visit,now:string,maxMinutes=120){
 const MAX_OPEN_MS=maxMinutes*60000;const currentStart=visit.activeAt??visit.at,stamp=Date.parse(now);
 const elapsed=(start:number,end:number)=>Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,end-start):0;
 const previous=(visit.sessions??[]).reduce((sum,s)=>sum+elapsed(Date.parse(s.at),Date.parse(s.leftAt)),0);
 const end=visit.leftAt?Date.parse(visit.leftAt):Math.min(stamp,Date.parse(currentStart)+MAX_OPEN_MS);
 return{arrival:visit.at,currentArrival:currentStart,departure:visit.leftAt??null,expired:!visit.leftAt&&stamp-Date.parse(currentStart)>=MAX_OPEN_MS,durationMs:previous+elapsed(Date.parse(currentStart),end)};
}
export function currentAttendance(state:GymState,branch:string,now:string){
 const members=new Map(state.members.filter(m=>m.branch===branch&&!m.archived&&!m.demo).map(m=>[m.id,m]));
 return presentVisits(state,branch,now).filter(v=>members.has(v.member)).sort((a,b)=>(b.activeAt??b.at).localeCompare(a.activeAt??a.at)).map(visit=>({visit,member:members.get(visit.member)!,timing:visitTiming(visit,now,receptionPolicy(state).autoExitMinutes)}));
}
export function durationLabel(milliseconds:number,ar:boolean){const minutes=Math.floor(Math.max(0,milliseconds)/60000),hours=Math.floor(minutes/60);return hours?(ar?`${hours} س ${minutes%60} د`:`${hours}h ${minutes%60}m`):(ar?`${minutes} دقيقة`:`${minutes} min`);}
