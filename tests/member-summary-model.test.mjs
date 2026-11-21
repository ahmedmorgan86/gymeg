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

// Randomized oracle: many histories and clocks, so a shape the hand fixture misses cannot hide a divergence.
let seed=12345;const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff,pick=a=>a[Math.floor(rnd()*a.length)];
const dayN=n=>new Date(Date.UTC(2026,0,1)+n*86400000).toISOString().slice(0,10);
function randomClub(){
  const s=fixture();s.visits=[];s.payments=[];s.invoices=[];
  const P=(id,a,b,x={})=>({id,plan:'pl',start:dayN(a),end:dayN(b),visits:null,...x});
  s.members=Array.from({length:25},(_,i)=>{const joined=Math.floor(rnd()*120),len=20+Math.floor(rnd()*300);
    const periods=pick([0,1,1,2,3]);const mp=Array.from({length:periods},(_,k)=>P('p'+i+'_'+k,joined+k*60,joined+len+k*60,{visits:pick([null,null,2,5]),quotaMode:pick([undefined,'sessions']),cancelled:rnd()<0.15}));
    return{id:'m'+i,branch:pick(['a','b']),joined:dayN(joined),expires:dayN(joined+len),archived:rnd()<0.08,awaitingSubscription:rnd()<0.05,...(periods?{membershipPeriods:mp}:{}),...(rnd()<0.3?{freezes:[{from:dayN(joined+10),to:dayN(joined+10+Math.floor(rnd()*20)),cancelled:rnd()<0.2}]}:{})};});
  let n=0;
  for(const m of s.members){
    const open=rnd()<0.3;const count=Math.floor(rnd()*14);
    for(let k=0;k<count;k++){const d=dayN(Math.floor(rnd()*200));const periodId=m.membershipPeriods&&rnd()<0.2?pick(m.membershipPeriods).id:undefined;
      s.visits.push({id:'v'+n++,member:m.id,branch:rnd()<0.8?m.branch:pick(['a','b']),day:d,at:d+'T0'+Math.floor(rnd()*9)+':00:00.000Z',leftAt:d+'T20:00:00.000Z',...(rnd()<0.2?{sessions:Array.from({length:Math.floor(rnd()*3)},()=>({}))}:{}),...(periodId?{periodId}:{})});}
    if(open){const d=dayN(70+Math.floor(rnd()*5));s.visits.push({id:'v'+n++,member:m.id,branch:m.branch,day:d,at:d+'T0'+Math.floor(rnd()*9)+':00:00.000Z',...(rnd()<0.4?{activeAt:d+'T10:30:00.000Z'}:{})});}
    for(let k=0;k<Math.floor(rnd()*4);k++){const minor=100*(1+Math.floor(rnd()*9));s.payments.push({id:'pay'+n++,member:m.id,branch:m.branch,minor,day:dayN(Math.floor(rnd()*150)),voided:rnd()<0.15});}
    for(let k=0;k<Math.floor(rnd()*3);k++){const mine=s.payments.filter(p=>p.member===m.id);s.invoices.push({id:'inv'+n++,member:m.id,branch:m.branch,total:100*(1+Math.floor(rnd()*20)),voided:rnd()<0.15,allocations:mine.slice(0,Math.floor(rnd()*2)).map(p=>({payment:p.id,minor:Math.min(p.minor,100)}))});}
  }
  return s;
}
test('randomized: stored + derived summary equals memberSummary (60 clubs x 25 members x 8 clocks)',()=>{
  let checked=0;
  for(let c=0;c<60;c++){
    const s=randomClub();
    const nows=Array.from({length:8},()=>dayN(Math.floor(rnd()*230))+'T'+pick(['00:30','08:00','12:00','15:00','21:59','23:30'])+':00.000Z');
    for(const m of s.members){const stored=strip(computeStoredSummary(s,m));
      for(const now of nows){const want=memberSummary(s,m,now),got=deriveSummary(stored,m,s.settings,now);
        for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid'])assert.deepEqual(strip(got[k]),strip(want[k]),`club ${c} ${m.id} @ ${now}: ${k}`);
        assert.equal(got.current?.id,want.current?.id,`club ${c} ${m.id} @ ${now}: current`);assert.equal(got.last?.id,want.last?.id,`club ${c} ${m.id} @ ${now}: last`);checked++;}}
  }
  console.log('SUMMARY-ORACLE randomized checks',checked);assert.equal(checked,60*25*8);
});
test('maintenance rule: after any real operation, only members whose own rows changed need a new stored summary',async()=>{
  const {applyOperation}=await import('../app/lib/domain.ts');
  const ids=()=>{let k=0;return()=>'g'+(k++)+'-aaaaaaaaaaaaaaaaaaaaaaaa';};
  let ops=0,changedMembers=0;
  for(let c=0;c<6;c++){
    const s=normalize(randomClub());const stored=new Map(s.members.map(m=>[m.id,strip(computeStoredSummary(s,m))]));
    const now='2026-03-15T12:00:00.000Z';
    for(let i=0;i<40;i++){
      const m=pick(s.members),op=pick([{type:'payment.add',branch:m.branch,id:m.id,minor:250,method:'cash'},{type:'visit.add',branch:m.branch,id:m.id},...s.visits.filter(v=>!v.leftAt).slice(0,3).map(v=>({type:'visit.exit',branch:v.branch,id:v.id}))]);
      let next;try{next=applyOperation(structuredClone(s),op,now,'t',ids());}catch{continue;}
      const rowsOf=(st,id)=>JSON.stringify([st.members.find(x=>x.id===id),st.visits.filter(v=>v.member===id),st.payments.filter(p=>p.member===id),st.invoices.filter(v=>v.member===id)]);
      const touched=s.members.filter(x=>rowsOf(s,x.id)!==rowsOf(next,x.id)).map(x=>x.id);changedMembers+=touched.length;ops++;
      for(const id of touched)stored.set(id,strip(computeStoredSummary(next,next.members.find(x=>x.id===id))));
      for(const x of next.members){const want=memberSummary(next,x,now),got=deriveSummary(stored.get(x.id),x,next.settings,now);for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid'])assert.deepEqual(strip(got[k]),strip(want[k]),`club ${c} op ${i} ${op.type} ${x.id}: ${k}`);}
      Object.assign(s,next);
    }
  }
  console.log('SUMMARY-MAINTENANCE ops',ops,'members touched',changedMembers);assert.ok(ops>50);
});
