import {test} from 'node:test';import assert from 'node:assert/strict';
import {visitCountView} from '../app/use-member-detail.ts';
test('visit count: strict legacy fallback is unknown (null), never a zero from an omitted list',()=>{
  assert.equal(visitCountView({visitCount:0,source:'legacy'},true),null);
  assert.equal(visitCountView({visitCount:7,source:'detail'},true),7);
  assert.equal(visitCountView({visitCount:0,source:'detail'},true),0);
  assert.equal(visitCountView({visitCount:4,source:'legacy'},false),4);
});
import {detailUnknown,chooseDetail} from '../app/use-member-detail.ts';
test('strict: a legacy detail is unknown; strict alone (summaries off) is unknown too, never false quota/no open visit',()=>{
  assert.equal(detailUnknown({source:'legacy'},true),true);assert.equal(detailUnknown({source:'detail'},true),false);assert.equal(detailUnknown({source:'legacy'},false),false);
});
test('hold: last detail of the same owner and member survives a newer state; other owner/member never matches',async()=>{
  const {emptyState}=await import('../app/lib/domain.ts');const {normalize}=await import('../app/lib/extensions.ts');const {computeStoredSummary}=await import('../app/lib/member-summary-model.ts');
  const s=normalize(emptyState());s.branches=[{id:'a',name:'A'}];
  const m={id:'m1',name:'X Y',phone:'01000000001',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[{id:'p1',plan:'pl',start:'2026-01-01',end:'2026-12-31',visits:3}]};s.members=[m];
  s.visits=[{id:'v2',member:'m1',branch:'a',day:'2026-03-02',at:'2026-03-02T10:00:00.000Z',leftAt:'2026-03-02T11:00:00.000Z'}];
  const now='2026-03-15T12:00:00.000Z',stored=computeStoredSummary(s,m,'2026-03-10T00:00:00.000Z',{allBranches:true});
  const d={owner:'o',member:'m1',forState:s,stored,invoices:[],payments:[]},s2={...s,visits:[]}; // newer state object (packet without visits)
  assert.equal(chooseDetail(true,d,s2,m,'o',now,false).source,'legacy','no hold: legacy for a newer state');
  const h=chooseDetail(true,d,s2,m,'o',now,true);assert.equal(h.source,'detail');assert.equal(h.visitCount,1);
  assert.equal(chooseDetail(true,d,s2,m,'o2',now,true).source,'legacy','other owner');
  assert.equal(chooseDetail(true,d,s2,{...m,id:'m2'},'o',now,true).source,'legacy','other member');
  assert.equal(chooseDetail(false,d,s2,m,'o',now,true).source,'legacy','flag off');
});
