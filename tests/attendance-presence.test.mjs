import {test} from 'node:test';import assert from 'node:assert/strict';
import {currentAttendance,visitTiming,durationLabel,resolveAttendanceNow} from '../app/lib/attendance-presence.ts';
import {emptyState} from '../app/lib/domain.ts';
const now='2026-10-26T10:00:00Z';
const visit={id:'v',member:'a',branch:'main',day:'2026-10-26',at:'2026-10-26T08:00:00Z'};
test('Visit time records include a live duration and a final checkout duration',()=>{assert.equal(visitTiming(visit,now).durationMs,2*3600000);assert.equal(visitTiming(visit,now).departure,null);const done=visitTiming({...visit,leftAt:'2026-10-26T09:30:00Z'},now);assert.equal(done.durationMs,90*60000);assert.equal(done.departure,'2026-10-26T09:30:00Z');});
test('Same-day re-entry sums sessions and excludes time spent outside the gym',()=>{const reentry={...visit,activeAt:'2026-10-26T09:45:00Z',sessions:[{at:visit.at,leftAt:'2026-10-26T09:00:00Z'}]};assert.equal(visitTiming(reentry,now).durationMs,75*60000);assert.equal(visitTiming(reentry,now).currentArrival,reentry.activeAt);assert.equal(visitTiming({...reentry,leftAt:'2026-10-26T09:50:00Z'},now).durationMs,65*60000);});
test('Presence isolates branch, removes checked-out, future, stale, archived and demo records',()=>{const s=emptyState();s.members=[{id:'a',branch:'main',demo:false,archived:false},{id:'demo',branch:'main',demo:true},{id:'archived',branch:'main',archived:true},{id:'other',branch:'other'}];s.visits=[visit,{...visit,id:'demo-v',member:'demo'},{...visit,id:'arch-v',member:'archived'},{...visit,id:'other-v',member:'other',branch:'other'}];assert.deepEqual(currentAttendance(s,'main','2026-10-26T09:59:59Z').map(x=>x.member.id),['a']);s.visits[0]={...visit,leftAt:'2026-10-26T09:00:00Z'};assert.equal(currentAttendance(s,'main',now).length,0);s.visits[0]={...visit,at:'2026-10-26T11:00:00Z'};assert.equal(currentAttendance(s,'main',now).length,0);s.visits[0]={...visit,at:'2026-10-25T22:00:00Z'};assert.equal(currentAttendance(s,'main',now).length,0);assert.equal(visitTiming(s.visits[0],now).expired,true);assert.equal(visitTiming(s.visits[0],now).durationMs,2*3600000);});
test('Open visits remain visible across midnight and duration formatting is bounded',()=>{const s=emptyState();s.members=[{id:'a',branch:'main'}];s.visits=[{...visit,day:'2026-10-25',at:'2026-10-25T23:00:00Z'}];assert.equal(currentAttendance(s,'main','2026-10-26T00:59:59Z').length,1);assert.equal(durationLabel(75*60000,false),'1h 15m');assert.equal(durationLabel(-100,true),'0 دقيقة');});

test('Duration follows a non-default exit limit and ignores malformed historical sessions',()=>{
 const reentry={...visit,activeAt:'2026-10-26T09:50:00Z',sessions:[{at:visit.at,leftAt:'2026-10-26T08:15:00Z'},{at:'invalid',leftAt:'2026-10-26T08:20:00Z'}]};
 assert.equal(visitTiming(reentry,now,30).durationMs,25*60000);
 assert.equal(visitTiming(reentry,'2026-10-26T10:40:00Z',30).durationMs,45*60000);
 assert.equal(visitTiming(reentry,'2026-10-26T10:40:00Z',30).expired,true);
});

test('Attendance clock anchors to server asOf or fallbackServerNow, ignoring device clock skew',()=>{
 const serverIso='2026-11-25T10:00:00.000Z',serverMs=Date.parse(serverIso);
 // Even before /api/presence arrives (check=null), fallbackServerNow + monotonic elapsed time is used
 assert.equal(resolveAttendanceNow('o','main',null,1500,serverMs,1000),'2026-11-25T10:00:00.500Z');
 // With /api/presence check scoped to current owner|branch, check.asOf wins
 const check={scope:'o|main',checkedAt:2000,asOf:'2026-11-25T10:05:00.000Z',connected:true};
 assert.equal(resolveAttendanceNow('o','main',check,7000,serverMs,1000),'2026-11-25T10:05:05.000Z');
 // Mismatched scope falls back to fallbackServerNow rather than stale branch check
 assert.equal(resolveAttendanceNow('o','other',check,3000,serverMs,1000),'2026-11-25T10:00:02.000Z');
});
