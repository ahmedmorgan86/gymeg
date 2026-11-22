import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {chooseQuotaIssues}=await import('../app/use-quota-issues.ts');
const A={},B={};const got={owner:'o',branch:'a',day:'d',forState:A,quota:new Set(['m'])};
test('held set is used only for the same state, owner, branch and day and only when ON',()=>{
  assert.equal(chooseQuotaIssues(true,got,A,'o','a','d'),got.quota);
  for(const args of [[B,'o','a','d'],[A,'x','a','d'],[A,'o','b','d'],[A,'o','a','e']])assert.equal(chooseQuotaIssues(true,got,...args),null);
  assert.equal(chooseQuotaIssues(false,got,A,'o','a','d'),null);assert.equal(chooseQuotaIssues(true,null,A,'o','a','d'),null);
});
test('Overview contract: every membershipIssue consumer goes through issueOf/composeIssue; day mismatch is unknown',()=>{
  const w=readFileSync(new URL('../app/workspace.tsx',import.meta.url),'utf8'),h=readFileSync(new URL('../app/use-quota-issues.ts',import.meta.url),'utf8');
  assert.match(w,/composeIssue\(s,m,today,QUOTA_ISSUES_ON,qSet,qStrict\)/);
  assert.equal((w.match(/membershipIssue\(/g)??[]).length,0,'workspace.tsx never reads packet visits directly');
  assert.match(w,/quotaUnknown\?"—":String\(active\.length\)/);assert.match(w,/issueFor=\{issueOf\}/);
  assert.match(h,/d\.day===day/);
});
const {composeIssue}=await import('../app/lib/quota-compose.ts');const {emptyState}=await import('../app/lib/domain.ts');const {normalize,membershipIssue}=await import('../app/lib/extensions.ts');
test('flag/set/strict combinations: never a wrong Active; strict-without-set is unknown only for visit-limited members',()=>{
  const s=normalize(emptyState());s.settings.timezone='Africa/Cairo';
  const P=(id,v)=>({id,plan:'pl',start:'2026-01-01',end:'2026-12-31',visits:v});
  s.members=[{id:'q',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[P('1',2)]},{id:'u',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[P('2',null)]},{id:'f',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[P('3',2)],freezes:[{from:'2026-03-01',to:'2026-03-30'}]}];
  for(let i=0;i<3;i++)s.visits.push({id:'v'+i,member:'q',branch:'a',day:'2026-03-0'+(i+1),at:'2026-03-0'+(i+1)+'T10:00:00.000Z',leftAt:'2026-03-0'+(i+1)+'T11:00:00.000Z'});
  const day='2026-03-15',L=m=>membershipIssue(s,m,day),[q,u,f]=s.members;assert.equal(L(q),'quota');
  const full=m=>composeIssue(s,m,day,true,null,false);                                   // ON, loading/error, non-strict, packet has visits -> legacy
  for(const m of s.members)assert.equal(full(m),L(m),m.id);assert.equal(composeIssue(s,q,day,false,null,true),'quota','OFF ignores everything');
  const omitted={...s,visits:[]};                                                         // omitted packet + set known
  const withSet=m=>composeIssue(omitted,m,day,true,new Set(['q']),true);for(const m of s.members)assert.equal(withSet(m),L(m),'set == legacy '+m.id);
  const empty=m=>composeIssue(omitted,m,day,true,new Set(),false);assert.equal(empty(q),null,'a KNOWN empty set is authoritative');
  const strict=m=>composeIssue(omitted,m,day,true,null,true);                             // loading/error in strict
  assert.equal(strict(q),'unknown');assert.equal(strict(u),null,'unlimited member has no visit-dependent issue');assert.equal(strict(f),'frozen','other issues stay exact');
});
const {drainDecision,drainDelay,DRAIN_MAX_ATTEMPTS,DRAIN_ZERO_MAX}=await import('../app/use-quota-issues.ts');
test('bounded drain follow-up: retry only with progress or busy, never past the cap, never on other failures',()=>{
  assert.equal(drainDecision({status:'fallback',reason:'draining',recomputed:100},1),'retry');
  assert.equal(drainDecision({status:'fallback',reason:'busy'},3),'retry');
  assert.equal(drainDecision({status:'fallback',reason:'draining',recomputed:0},1,0),'retry','one zero-progress race is tolerated');
  assert.equal(drainDecision({status:'fallback',reason:'draining',recomputed:0},4,DRAIN_ZERO_MAX),'stop','repeated zero progress stops');
  assert.ok(drainDelay(1,true,()=>0)>=1500&&drainDelay(5,true,()=>0)>drainDelay(1,true,()=>0),'busy backs off');assert.notEqual(drainDelay(2,true,()=>0.1),drainDelay(2,true,()=>0.9),'jitter');
  assert.equal(drainDecision({status:'fallback',reason:'draining',recomputed:100},DRAIN_MAX_ATTEMPTS),'stop','cap');
  for(const r of ['null-derivation','unready','too-many-members','unavailable'])assert.equal(drainDecision({status:'fallback',reason:r},1),'stop',r);
  assert.equal(drainDecision(null,1),'stop');assert.equal(drainDecision({status:'ok'},1),'stop');
});
test('load -> no-op packet replacement -> mutate -> queued sync replay: the hold survives no-ops (no idle flicker) and never outlives a quota-relevant change',async()=>{
  const {composeIssue,quotaSignature}=await import('../app/lib/quota-compose.ts');
  const m={id:'m1',branch:'a',name:'x',joined:'2026-01-01',expires:'2026-12-31',archived:false,membershipPeriods:[{id:'p1',start:'2026-01-01',end:'2026-12-31',visits:2}]};
  const D='2026-11-22',S0={members:[m],visits:[],payments:[],settings:{}},sig=(s,r=5)=>quotaSignature(s,'a',r);
  const held={owner:'o',branch:'a',day:D,forState:sig(S0),quota:new Set(['m1'])};
  const pick=s=>chooseQuotaIssues(true,held,sig(s),'o','a',D);
  assert.equal(composeIssue(S0,m,D,true,pick(S0),true),'quota');
  // idle polls / notification polls / unrelated sync create new packet objects with the same content (and unrelated collections changing): hold stays, no unknown flash
  for(const S of [{...S0},{...S0,visits:[]},{...S0,payments:[{id:'x'}],community:{messages:[1]}},{...S0,members:[{...m}]}])assert.equal(pick(S),held.quota,'no-op replacement keeps the held set');
  // another branch's change does not matter either
  assert.equal(pick({...S0,members:[m,{id:'z',branch:'b',joined:'2026-01-01',expires:'2026-12-31'}],visits:[{member:'z',branch:'b',day:D}]}),held.quota);
  // quota-relevant changes drop the hold: a new visit (mutation, then the queued sync replay of it), an edited period, a freeze, an archive
  const v={id:'v1',member:'m1',branch:'a',day:D,periodId:'p1'};
  for(const S of [{...S0,visits:[v]},{...S0,members:[{...m,membershipPeriods:[{...m.membershipPeriods[0],visits:3}]}]},{...S0,members:[{...m,archived:true}]},{...S0,members:[{...m,freezes:[{from:D,to:D}]}]},{...S0,members:[{...m,expires:'2026-11-30'}]}]){
    const set=pick(S);assert.equal(set,null,'stale hold must not apply after a quota-relevant change');
    assert.equal(composeIssue(S0,m,D,true,set,true),'unknown','strict: unknown while unfetched, never the stale quota answer or a false Active');}
  // a refetch for the new state replaces the hold
  const S2={...S0,visits:[v]},fresh={...held,forState:sig(S2),quota:new Set()};
  assert.equal(chooseQuotaIssues(true,fresh,sig(S2),'o','a',D),fresh.quota);
  // lazy/omit packet: NO visit rows. A check-in (or another station's write) is visible only as a revision change: the hold must drop, an unchanged revision must keep it
  const OM={...S0,visits:[]};assert.equal(chooseQuotaIssues(true,held,sig(OM,5),'o','a',D),held.quota,'omit packet, same revision: kept (idle, no flicker)');
  for(const r of [6,7])assert.equal(chooseQuotaIssues(true,held,sig(OM,r),'o','a',D),null,'omit packet, revision-only change: dropped, refetched');
  // settings timezone, day rollover (day is in the hook key), unambiguous serialization
  assert.equal(chooseQuotaIssues(true,held,sig({...S0,settings:{timezone:'UTC'}}),'o','a',D),null,'timezone change drops the hold');
  assert.equal(chooseQuotaIssues(true,held,sig(S0),'o','a','2026-11-23'),null,'day rollover drops the hold');
  const mm=(id,x)=>({...m,id,expires:x});assert.notEqual(sig({...S0,members:[mm('a~b','c'),mm('d','e')]}),sig({...S0,members:[mm('a','b~c'),mm('d','e')]}));
  assert.notEqual(sig({...S0,members:[mm('a|b','c')]}),sig({...S0,members:[mm('a','b|c')]}),'delimiter-containing ids never collide');
  // offline: the hook's only network failure path drops the hold and flags failed (Retry), never keeping a stale slice
  const h=readFileSync(new URL('../app/use-quota-issues.ts',import.meta.url),'utf8');
  assert.match(h,/catch\{if\(!ac\.signal\.aborted&&sigRef\.current===state\)\{setGot\(null\);setFailedFor\(state\);\}\}/);
  assert.match(h,/if\(inflight\.current\)\{queued\.current=true;return;\}/,'single flight: a change while a read runs queues, never a second request');
  assert.doesNotMatch(h,/return\(\)=>\{clearTimeout\(timer\);if\(next\)clearTimeout\(next\);ac\.abort\(\);\}/,'a revision change must not abort the in-flight read');
  assert.match(h,/quotaSignature\(stateObj,branch,revision\)/);
});
