import {test} from 'node:test';import assert from 'node:assert/strict';import {checkinProfile,checkinProfileFromOpen,packetClockAnchor,openNow} from '../app/lib/checkin-profile.ts';
const now=Date.parse('2026-10-25T10:00:00Z'),base={members:[{id:'a',branch:'main'},{id:'b',branch:'other'}],visits:[]},visit={id:'v',member:'a',branch:'main',at:new Date(now).toISOString()};
test('Attendance profile opens only for a new confirmed entry in the visible branch',()=>{const next={...base,visits:[visit]};assert.equal(checkinProfile(null,next,'main',now),null);assert.equal(checkinProfile(base,next,'main',now),'a');assert.equal(checkinProfile(next,next,'main',now),null);assert.equal(checkinProfile(base,next,'other',now),null);assert.equal(checkinProfile(base,{...next,generation:'restored'},'main',now),null);assert.equal(checkinProfile(base,next,'main',now+180000),null);assert.equal(checkinProfile(base,{...base,visits:[{...visit,leftAt:visit.at}]},'main',now),null);});
test('Same-day reentry opens again; unrelated updates do not',()=>{const old={...base,visits:[{...visit,at:new Date(now-60000).toISOString(),leftAt:new Date(now-30000).toISOString()}]},next={...base,visits:[{...visit,activeAt:visit.at}]};assert.equal(checkinProfile(old,next,'main',now),'a');assert.equal(checkinProfile(next,next,'main',now),null);});

test('actual same-day domain exit and reentry preserve popup oracle parity',async()=>{
 const {emptyState,applyOperation}=await import('../app/lib/domain.ts');
 let state=emptyState();let n=0;const id=()=>String(++n),at=k=>new Date(now+k*1000).toISOString();
 state=applyOperation(state,{type:'member.save',branch:'main',name:'Synthetic Local Member',phone:'01012345678',joined:'2026-10-01',expires:'2026-12-31'},at(-100),'QA',id);
 const m=state.members[0],open=s=>s.visits.filter(v=>!v.leftAt&&v.branch==='main'),map=s=>new Map(open(s).map(v=>[v.id,v.activeAt??v.at]));
 let previous=state;
 for(let cycle=0;cycle<4;cycle++){
  const t=cycle*10;state=applyOperation(state,{type:'visit.add',branch:'main',id:m.id},at(t),'QA',id);
  const ms=new Set([m.id]);assert.equal(checkinProfile(previous,state,'main',Date.parse(at(t))),m.id);
  assert.equal(checkinProfileFromOpen(map(previous),open(state),ms,Date.parse(at(t))),m.id);
  assert.equal(state.visits.length,1,'reentry reuses the same visit ID');
  if(cycle)assert.equal(state.visits[0].activeAt,at(t),'reentry advances activeAt');
  const entered=state;state=applyOperation(state,{type:'visit.exit',branch:'main',id:state.visits[0].id},at(t+3),'QA',id);
  assert.equal(checkinProfile(entered,state,'main',Date.parse(at(t+3))),null);
  assert.equal(checkinProfileFromOpen(map(entered),open(state),ms,Date.parse(at(t+3))),null);previous=state;
 }
});

test('real deltas preserve snapshot clock anchor so later check-ins stay recent',async()=>{
 const {applyWorkspaceDeltas}=await import('../app/lib/workspace-sync.ts');
 const packet={state:base,serverNow:now,revision:1},recv=1000000,arrival=recv+180000;
 const delta=applyWorkspaceDeltas(packet,[{id:'e',revision:2,eventType:'entity.upsert',collection:'visits',entityId:'v',payload:{...visit,at:new Date(now+180000).toISOString()}}]);
 assert.equal(delta.serverNow,packet.serverNow,'delta retains original snapshot clock');
 const anchor=packetClockAnchor(packet,delta,true,recv,arrival);
 assert.equal(anchor,recv);assert.equal(openNow(delta.serverNow,anchor,arrival),now+180000);
 const entries=delta.state.visits;
 assert.equal(checkinProfileFromOpen(new Map(),entries,new Set(['a']),openNow(delta.serverNow,anchor,arrival)),'a');
 assert.equal(checkinProfileFromOpen(new Map(),entries,new Set(['a']),openNow(delta.serverNow,arrival,arrival)),null,'old reanchor silently misses check-in');
 assert.equal(packetClockAnchor(packet,{...delta,serverNow:now+100},true,recv,arrival),arrival,'new snapshot gets fresh anchor');
 assert.equal(packetClockAnchor(packet,delta,false,recv,arrival),arrival,'account change resets anchor');
});
