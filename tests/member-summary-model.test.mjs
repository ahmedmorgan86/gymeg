import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {computeStoredSummary,deriveSummary}=await import('../app/lib/member-summary-model.ts');
const {memberSummary}=await import('../app/lib/member-console.ts');
const {emptyState}=await import('../app/lib/domain.ts');
const {normalize}=await import('../app/lib/extensions.ts');

function fixture(){
  const s=normalize(emptyState());s.branches=[{id:'a',name:'A'},{id:'b',name:'B'}];s.settings.timezone='Africa/Cairo';
  const P=(id,start,end,extra={})=>({id,plan:'pl',start,end,visits:null,...extra});
  s.members=[
    {id:'plain',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[P('p1','2026-01-01','2026-12-31')]},
    {id:'quota',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[P('q1','2026-01-01','2026-12-31',{visits:3})]},
    {id:'sess',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[P('s1','2026-01-01','2026-12-31',{visits:5,quotaMode:'sessions'})]},
    {id:'frozen',branch:'b',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[P('f1','2026-01-01','2026-12-31')],freezes:[{from:'2026-03-10',to:'2026-03-20'}]},
    {id:'ending',branch:'b',joined:'2026-01-01',expires:'2026-03-17',membershipPeriods:[P('e1','2026-01-01','2026-03-17')]},
    {id:'twoperiods',branch:'a',joined:'2025-01-01',expires:'2026-12-31',membershipPeriods:[P('t1','2025-01-01','2025-12-31',{visits:2}),P('t2','2026-01-01','2026-12-31',{visits:4}),P('tx','2026-02-01','2026-02-28',{cancelled:true})]},
    {id:'legacy',branch:'a',joined:'2026-01-01',expires:'2026-06-30'},
    {id:'archived',branch:'a',joined:'2026-01-01',expires:'2026-12-31',archived:true,membershipPeriods:[P('r1','2026-01-01','2026-12-31')]},
    {id:'future',branch:'a',joined:'2026-05-01',expires:'2026-12-31',membershipPeriods:[P('u1','2026-05-01','2026-12-31')]},
    {id:'awaiting',branch:'a',joined:'2026-01-01',expires:'2026-12-31',awaitingSubscription:true},
    {id:'none',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[]},
  ];
  let n=0;const V=(member,day,x={})=>s.visits.push({id:'v'+n++,member,branch:'a',day,at:day+'T10:00:00.000Z',leftAt:day+'T11:00:00.000Z',...x});
  for(const d of ['2026-03-01','2026-03-02','2026-03-05'])V('quota',d);
  for(const d of ['2026-03-01','2026-03-03'])V('sess',d,{sessions:[{},{}]});
  V('sess','2026-03-06',{sessions:[{}]});V('sess','2026-03-07',{branch:'b'});
  for(const d of ['2025-05-01','2025-06-01','2026-02-10','2026-03-12'])V('twoperiods',d);
  V('twoperiods','2026-03-13',{periodId:'t1'});V('twoperiods','2026-02-15',{periodId:'tx'});
  V('plain','2026-03-14',{leftAt:undefined,at:'2026-03-15T09:00:00.000Z'});               // open, inside auto-exit at noon, outside by 15:00
  V('plain','2026-03-15',{leftAt:undefined,at:'2026-03-15T11:00:00.000Z',activeAt:'2026-03-15T11:30:00.000Z'});
  V('legacy','2026-03-01');V('frozen','2026-03-05',{branch:'b'});V('quota','2026-03-20');   // a visit later than the clock
  s.invoices=[{id:'i1',member:'plain',branch:'a',total:1000,due:'2026-03-01',voided:false,allocations:[{payment:'p1',minor:400}]},{id:'i2',member:'plain',branch:'a',total:500,voided:true,allocations:[]},{id:'i3',member:'quota',branch:'a',total:300,voided:false,allocations:[]}];
  s.payments=[{id:'p1',member:'plain',branch:'a',minor:400,day:'2026-03-02'},{id:'p2',member:'plain',branch:'a',minor:50,voided:true},{id:'p3',member:'quota',branch:'a',minor:70}];
  return s;
}
const strip=x=>JSON.parse(JSON.stringify(x));
test('stored + derived summary equals memberSummary for every member at many clock times',()=>{
  const s=fixture();
  const nows=['2026-03-15T08:00:00.000Z','2026-03-15T12:00:00.000Z','2026-03-15T12:45:00.000Z','2026-03-15T15:00:00.000Z','2026-03-18T10:00:00.000Z','2026-03-20T22:30:00.000Z','2026-03-31T21:59:00.000Z','2026-04-01T00:30:00.000Z','2026-07-01T10:00:00.000Z','2027-01-02T10:00:00.000Z'];
  let checked=0;
  for(const m of s.members){
    const stored=strip(computeStoredSummary(s,m));
    for(const now of nows){
      const want=memberSummary(s,m,now),got=deriveSummary(stored,m,s.settings,now);
      for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid']){
        assert.deepEqual(strip(got[k]),strip(want[k]),`${m.id} @ ${now}: ${k}`);
      }
      assert.equal(got.current?.id,want.current?.id,`${m.id} @ ${now}: current visit`);
      assert.equal(got.last?.id,want.last?.id,`${m.id} @ ${now}: last`);
      checked++;
    }
  }
  assert.equal(checked,s.members.length*nows.length);
});
test('stored summary holds only time-independent inputs',()=>{
  const s=fixture();const a=strip(computeStoredSummary(s,s.members[0])),b=strip(computeStoredSummary(s,s.members[0]));
  assert.deepEqual(a,b);assert.ok(!JSON.stringify(a).includes('"status"')&&!JSON.stringify(a).includes('remaining'));
});
test('backfill (grouped, single pass) equals per-member compute on the full state',async()=>{
  const {backfillSummaries}=await import('../app/lib/member-summary-model.ts');
  const s=fixture(),all=backfillSummaries(s);
  assert.equal(all.size,s.members.length);
  for(const m of s.members)assert.deepEqual(strip(all.get(m.id)),strip(computeStoredSummary(s,m)),m.id);
});
