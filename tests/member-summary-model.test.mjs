import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {computeStoredSummary,deriveSummary}=await import('../app/lib/member-summary-model.ts');
const {memberSummary}=await import('../app/lib/member-console.ts');
const {emptyState,dayAt}=await import('../app/lib/domain.ts');
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
const localOf=(s,m)=>({...s,members:[m],visits:s.visits.filter(v=>v.member===m.id&&v.branch===m.branch),payments:s.payments.filter(p=>p.member===m.id&&p.branch===m.branch),invoices:(s.invoices??[]).filter(i=>i.member===m.id&&i.branch===m.branch)});
const ORACLE=(s,m,now)=>memberSummary(localOf(s,m),m,now); // what consoleIndex(branch) computes for a member of that branch
const strip=x=>JSON.parse(JSON.stringify(x));
test('stored + derived summary equals memberSummary for every member at many clock times',()=>{
  const s=fixture();
  const nows=['2026-03-15T08:00:00.000Z','2026-03-15T12:00:00.000Z','2026-03-15T12:45:00.000Z','2026-03-15T15:00:00.000Z','2026-03-18T10:00:00.000Z','2026-03-20T22:30:00.000Z','2026-03-31T21:59:00.000Z','2026-04-01T00:30:00.000Z','2026-07-01T10:00:00.000Z','2027-01-02T10:00:00.000Z'];
  let checked=0,nulls=0;
  // compute clocks: before every visit (all visits in the tail), mid-fixture (mixed), after every visit (everything folded into totals)
  for(const asOf of ['2026-01-01T00:00:00.000Z','2026-03-04T12:00:00.000Z','2026-03-14T23:30:00.000Z','2026-03-16T01:00:00.000Z','2026-12-01T00:00:00.000Z'])
  for(const m of s.members){
    const stored=strip(computeStoredSummary(s,m,asOf));
    for(const now of nows){
      const want=ORACLE(s,m,now),got=deriveSummary(stored,m,s.settings,now);
      if(got===null){assert.ok(dayAt(now,s.settings.timezone)<stored.horizon,`${m.id} @ ${now} asOf ${asOf}: null only before the horizon`);nulls++;continue;}
      for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid']){
        assert.deepEqual(strip(got[k]),strip(want[k]),`${m.id} @ ${now}: ${k}`);
      }
      assert.equal(got.current?.id,want.current?.id,`${m.id} @ ${now}: current visit`);
      assert.equal(got.last?.id,want.last?.id,`${m.id} @ ${now}: last`);
      checked++;
    }
  }
  assert.equal(checked+nulls,5*s.members.length*nows.length);assert.ok(checked>s.members.length*nows.length,'most combinations answered exactly');assert.ok(nulls>0,'the before-horizon refusal is exercised');
});
test('stored summary holds only time-independent inputs and is small',()=>{
  const s=fixture();const a=strip(computeStoredSummary(s,s.members[0],'2026-03-16T00:00:00.000Z')),b=strip(computeStoredSummary(s,s.members[0],'2026-03-16T00:00:00.000Z'));assert.ok(!('usage' in a),'no per-visit usage list');
  assert.deepEqual(a,b);assert.ok(!JSON.stringify(a).includes('"status"')&&!JSON.stringify(a).includes('remaining'));
});
test('backfill (grouped, single pass) equals per-member compute on the full state',async()=>{
  const {backfillSummaries}=await import('../app/lib/member-summary-model.ts');
  const AS='2026-03-16T00:00:00.000Z';const s=fixture(),all=backfillSummaries(s,AS);
  assert.equal(all.size,s.members.length);
  for(const m of s.members)assert.deepEqual(strip(all.get(m.id)),strip(computeStoredSummary(s,m,AS)),m.id);
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
  let checked=0,nullsR=0;
  for(let c=0;c<60;c++){
    const s=randomClub();
    const nows=Array.from({length:8},()=>dayN(Math.floor(rnd()*230))+'T'+pick(['00:30','08:00','12:00','15:00','21:59','23:30'])+':00.000Z');
    const asOf=dayN(Math.floor(rnd()*230))+'T'+pick(['00:30','12:00','23:30'])+':00.000Z';
    for(const m of s.members){const stored=strip(computeStoredSummary(s,m,asOf));
      for(const now of nows){const want=ORACLE(s,m,now),got=deriveSummary(stored,m,s.settings,now);
        if(got===null){assert.ok(dayAt(now,s.settings.timezone)<stored.horizon);nullsR++;checked++;continue;}
        for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid'])assert.deepEqual(strip(got[k]),strip(want[k]),`club ${c} ${m.id} @ ${now}: ${k}`);
        assert.equal(got.current?.id,want.current?.id,`club ${c} ${m.id} @ ${now}: current`);assert.equal(got.last?.id,want.last?.id,`club ${c} ${m.id} @ ${now}: last`);checked++;}}
  }
  console.log('SUMMARY-ORACLE randomized checks',checked,'of which refused before horizon',nullsR);assert.ok(nullsR<checked*0.7);assert.equal(checked,60*25*8);
});
test('maintenance rule: after any real operation, only members whose own rows changed need a new stored summary',async()=>{
  const {applyOperation}=await import('../app/lib/domain.ts');
  const ids=()=>{let k=0;return()=>'g'+(k++)+'-aaaaaaaaaaaaaaaaaaaaaaaa';};
  let ops=0,changedMembers=0;
  for(let c=0;c<6;c++){
    const s=normalize(randomClub());const AS='2026-03-14T12:00:00.000Z';const stored=new Map(s.members.map(m=>[m.id,strip(computeStoredSummary(s,m,AS))]));
    const now='2026-03-15T12:00:00.000Z';
    for(let i=0;i<40;i++){
      const m=pick(s.members),op=pick([{type:'payment.add',branch:m.branch,id:m.id,minor:250,method:'cash'},{type:'visit.add',branch:m.branch,id:m.id},...s.visits.filter(v=>!v.leftAt).slice(0,3).map(v=>({type:'visit.exit',branch:v.branch,id:v.id}))]);
      let next;try{next=applyOperation(structuredClone(s),op,now,'t',ids());}catch{continue;}
      const rowsOf=(st,id)=>JSON.stringify([st.members.find(x=>x.id===id),st.visits.filter(v=>v.member===id),st.payments.filter(p=>p.member===id),st.invoices.filter(v=>v.member===id)]);
      const touched=s.members.filter(x=>rowsOf(s,x.id)!==rowsOf(next,x.id)).map(x=>x.id);changedMembers+=touched.length;ops++;
      for(const id of touched)stored.set(id,strip(computeStoredSummary(next,next.members.find(x=>x.id===id),AS)));
      for(const x of next.members){const want=ORACLE(next,x,now),got=deriveSummary(stored.get(x.id),x,next.settings,now);for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid'])assert.deepEqual(strip(got[k]),strip(want[k]),`club ${c} op ${i} ${op.type} ${x.id}: ${k}`);}
      Object.assign(s,next);
    }
  }
  console.log('SUMMARY-MAINTENANCE ops',ops,'members touched',changedMembers);assert.ok(ops>50);
});

test('differential against the REAL consoleIndex(branch): cross-branch rows, both branches, many clocks and compute horizons',async()=>{
  const {consoleIndex}=await import('../app/lib/member-console.ts');
  let checked=0,nulls=0;
  const fields=['period','issue','remaining','debt','status','used','visitsRemaining','paid'];
  const scenario=(s,label)=>{
    for(const asOf of ['2026-01-01T00:00:00.000Z','2026-03-10T12:00:00.000Z','2026-03-14T23:30:00.000Z','2026-12-01T00:00:00.000Z'])
    for(const now of ['2026-03-15T08:00:00.000Z','2026-03-15T15:00:00.000Z','2026-03-20T22:30:00.000Z','2026-04-02T10:00:00.000Z','2027-01-02T10:00:00.000Z'])
    for(const branch of ['a','b']){
      for(const {m,summary} of consoleIndex(s,branch,now)){
        const got=deriveSummary(strip(computeStoredSummary(s,m,asOf)),m,s.settings,now);
        if(got===null){assert.ok(dayAt(now,s.settings.timezone)<computeStoredSummary(s,m,asOf).horizon);nulls++;continue;}
        for(const k of fields)assert.deepEqual(strip(got[k]),strip(summary[k]),`${label} ${branch} ${m.id} @ ${now} asOf ${asOf}: ${k}`);
        assert.equal(got.last?.id,summary.last?.id,`${label} ${m.id}: last`);assert.equal(got.current?.id,summary.current?.id,`${label} ${m.id}: current`);checked++;
      }
    }
  };
  const s=fixture();
  s.visits.push({id:'xv',member:'quota',branch:'b',day:'2026-03-10',at:'2026-03-10T10:00:00.000Z',leftAt:'2026-03-10T11:00:00.000Z'});
  s.payments.push({id:'xp',member:'quota',branch:'b',minor:900});
  s.invoices.push({id:'xi',member:'quota',branch:'b',total:5000,voided:false,allocations:[]});
  s.invoices.push({id:'xi2',member:'plain',branch:'a',total:700,voided:false,allocations:[{payment:'xp',minor:300}]}); // allocation to a payment recorded at another branch
  scenario(s,'reviewer-fixture');
  for(let c=0;c<15;c++)scenario(normalize(randomClub()),'club'+c);
  console.log('CONSOLE-INDEX differential checks',checked,'refused before horizon',nulls);assert.ok(checked>2000);
});

test('list layer: rows, summary fields and the exact search string equal consoleIndex(state,branch,now); unknown cases fall back',async()=>{
  const {consoleIndex}=await import('../app/lib/member-console.ts');
  const {consoleIndexFromCandidates,CandidateCache}=await import('../app/lib/member-console-candidates.ts');
  let rows=0,fallbacks=0;
  const fields=['period','issue','remaining','debt','status','used','visitsRemaining','paid','plan'];
  // the screen reads only id/at/activeAt of the current visit and id/at of the last one
  const cur=x=>x?{id:x.id,at:x.at,activeAt:x.activeAt}:null,lst=x=>x?{id:x.id,at:x.at}:null;
  const eq=(x,y,m)=>assert.equal(JSON.stringify(x)??'undefined',JSON.stringify(y)??'undefined',m);
  const one=(s,label)=>{
    s.plans=[{id:'pl',name:'شهري Monthly',price:100}];
    for(const asOf of ['2026-01-01T00:00:00.000Z','2026-03-14T23:30:00.000Z','2026-12-01T00:00:00.000Z'])
    for(const now of ['2026-03-15T08:00:00.000Z','2026-03-20T22:30:00.000Z','2027-01-02T10:00:00.000Z'])
    for(const branch of ['a','b']){
      const want=consoleIndex(s,branch,now);
      const cands=s.members.map(m=>({member:m,stored:strip(computeStoredSummary(s,m,asOf))}));
      const got=consoleIndexFromCandidates(cands,{settings:s.settings,plans:s.plans},branch,now);
      if(got.status==='fallback'){fallbacks++;assert.ok(want.length>=0);continue;}
      assert.deepEqual(got.rows.map(r=>r.m.id),want.map(r=>r.m.id),`${label} ${branch}: same members, same order`);
      got.rows.forEach((r,i)=>{for(const k of fields)eq(r.summary[k],want[i].summary[k],`${label} ${branch} ${r.m.id} ${k}`);eq(cur(r.summary.current),cur(want[i].summary.current),`${label} ${r.m.id} current`);eq(lst(r.summary.last),lst(want[i].summary.last),`${label} ${r.m.id} last`);assert.equal(r.search,want[i].search,`${label} ${r.m.id}: search string`);rows++;});
    }
  };
  one(fixture(),'fixture');for(let c=0;c<10;c++)one(normalize(randomClub()),'club'+c);
  console.log('LIST-LAYER rows compared',rows,'fallback calls',fallbacks);assert.ok(rows>500&&fallbacks>0);
  // a v1 row or a stale version never answers
  const s=fixture();const cands=s.members.map(m=>({member:m,stored:{...strip(computeStoredSummary(s,m,'2026-03-10T00:00:00.000Z')),v:1}}));
  assert.equal(consoleIndexFromCandidates(cands,{settings:s.settings},'a','2026-03-15T08:00:00.000Z').status,'fallback');
  // version-aware cache: owner, branch, permission scope and version must all match
  const cache=new CandidateCache();cache.put('o','a','admin',"5",cands);
  assert.equal(cache.get('o','a','admin','5'),cands);assert.equal(cache.versionFor('o','a','admin'),'5');
  assert.equal(cache.get('o','a','admin','6'),null,'newer version is a miss');assert.equal(cache.get('o','b','admin','5'),null,'other branch');assert.equal(cache.get('p','a','admin','5'),null,'other owner');
  assert.equal(cache.get('o','a','reception-nofin','5'),null,'other permission scope is a miss');assert.equal(cache.versionFor('o','a','reception-nofin'),null);
  cache.clear();assert.equal(cache.get('o','a','admin','5'),null,'cleared on sign-out/tenant switch');
});
test('list source: candidates fetched for an older state are never mixed with a newer state (mutation regression)',async()=>{
  const {chooseRows}=await import('../app/use-console-index.ts');const {emptyState}=await import('../app/lib/domain.ts');const {normalize}=await import('../app/lib/extensions.ts');
  const {computeStoredSummary}=await import('../app/lib/member-summary-model.ts');
  const s1=normalize(emptyState());s1.branches=[{id:'a',name:'A'}];s1.members=[{id:'m1',name:'Old Name',phone:'01000000001',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[{id:'p1',plan:'pl',start:'2026-01-01',end:'2026-12-31',visits:null}]}];
  const stamp=Date.parse('2026-03-15T12:00:00Z');
  const cands={owner:'o',branch:'a',scope:'admin:fin',forState:s1,list:[{member:s1.members[0],stored:computeStoredSummary(s1,s1.members[0],'2026-03-01T00:00:00.000Z')}]};
  assert.equal(chooseRows(true,cands,s1,'a','o','admin:fin',stamp).source,'candidates');
  const s2=structuredClone(s1);s2.members[0].name='New Name';s2.settings.receptionPolicy={...(s2.settings.receptionPolicy??{}),autoExitMinutes:5};
  const after=chooseRows(true,cands,s2,'a','o','admin:fin',stamp);assert.equal(after.source,'legacy','state changed: exact legacy until matching candidates arrive');assert.equal(after.rows[0].m.name,'New Name','the updated member is shown, never the stale candidate');
  assert.equal(chooseRows(true,cands,s1,'a','o2','admin:fin',stamp).source,'legacy','tenant switch');assert.equal(chooseRows(true,cands,s1,'a','o','reception:nofin',stamp).source,'legacy','permission change');
  assert.equal(chooseRows(false,cands,s1,'a','o','admin:fin',stamp).source,'legacy','flag off is always legacy');
});
test('detail source: only a detail fetched for this state, member and tenant is used; otherwise the exact legacy summary',async()=>{
  const {chooseDetail}=await import('../app/use-member-detail.ts');const {emptyState}=await import('../app/lib/domain.ts');const {normalize}=await import('../app/lib/extensions.ts');
  const {computeStoredSummary}=await import('../app/lib/member-summary-model.ts');const {memberSummary}=await import('../app/lib/member-console.ts');
  const s=normalize(emptyState());s.branches=[{id:'a',name:'A'},{id:'b',name:'B'}];
  const m={id:'m1',name:'X Y',phone:'01000000001',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[{id:'p1',plan:'pl',start:'2026-01-01',end:'2026-12-31',visits:3}]};s.members=[m];
  s.visits=[{id:'v1',member:'m1',branch:'b',day:'2026-03-01',at:'2026-03-01T10:00:00.000Z',leftAt:'2026-03-01T11:00:00.000Z'},{id:'v2',member:'m1',branch:'a',day:'2026-03-02',at:'2026-03-02T10:00:00.000Z',leftAt:'2026-03-02T11:00:00.000Z'}];
  const now='2026-03-15T12:00:00.000Z',stored=computeStoredSummary(s,m,'2026-03-10T00:00:00.000Z',{allBranches:true});
  const d={owner:'o',member:'m1',forState:s,stored,invoices:[],payments:[]};
  const got=chooseDetail(true,d,s,m,'o',now),want=memberSummary(s,m,now);
  assert.equal(got.source,'detail');assert.equal(got.visitCount,2,'all-branch visit count');
  for(const k of ['used','remaining','status','issue','visitsRemaining','debt','paid'])assert.deepEqual(got.x[k],want[k],k);
  const s2=structuredClone(s);assert.equal(chooseDetail(true,d,s2,m,'o',now).source,'legacy','state changed');assert.equal(chooseDetail(true,d,s,m,'o2',now).source,'legacy','tenant');assert.equal(chooseDetail(false,d,s,m,'o',now).source,'legacy','flag off');
  assert.equal(chooseDetail(true,d,s,m,'o','2026-03-05T12:00:00.000Z').source,'legacy','screen clock before the stored horizon: legacy, never a wrong answer');
});
test('detail clock: only a screen clock within one day behind the server is honored (instants, not strings)',async()=>{
  const {detailAsOf,ASOF_MAX_SKEW_MS}=await import('../app/lib/member-detail-source.ts');
  const now=Date.parse('2026-03-15T12:00:00.000Z'),N=new Date(now).toISOString();
  assert.equal(detailAsOf(undefined,now),N);assert.equal(detailAsOf('',now),N);
  assert.equal(detailAsOf('2026-03-15T10:00:00.000Z',now),'2026-03-15T10:00:00.000Z');
  assert.equal(detailAsOf(new Date(now-ASOF_MAX_SKEW_MS).toISOString(),now),new Date(now-ASOF_MAX_SKEW_MS).toISOString(),'exactly one day behind is honored');
  for(const bad of ['2000-01-01T00:00:00.000Z','2026-03-14T11:59:59.999Z','2026-03-16T00:00:00.000Z','2099-01-01T00:00:00.000Z','garbage','2026-13-45T00:00:00Z','1','0','-1','Infinity'])assert.equal(detailAsOf(bad,now),N,'ignored: '+bad);
  assert.equal(detailAsOf('2026-03-15',now),'2026-03-15T00:00:00.000Z','a date-only value is the instant at midnight UTC, 12h behind: honored');
  assert.equal(detailAsOf('2026-03-15T14:00:00+02:00',now),'2026-03-15T12:00:00.000Z','offset form is compared as an instant and re-serialized canonically');
  assert.equal(detailAsOf('2026-03-15T15:00:00+02:00',now),N,'an instant later than the server clock (13:00Z) written with an offset is not honored');
});
test('today visits: server data is used only for the same state, tenant, branch and day',async()=>{
  const {chooseToday}=await import('../app/use-today-visits.ts');const s={};const s2={};
  const got={owner:'o',branch:'a',day:'2026-03-15',forState:s,data:{count:3,latest:[]}};
  assert.equal(chooseToday(true,got,s,'o','a','2026-03-15')?.count,3);
  for(const [st,o,b,d] of [[s2,'o','a','2026-03-15'],[s,'p','a','2026-03-15'],[s,'o','b','2026-03-15'],[s,'o','a','2026-03-16']])assert.equal(chooseToday(true,got,st,o,b,d),null);
  assert.equal(chooseToday(false,got,s,'o','a','2026-03-15'),null,'flag off');
});
