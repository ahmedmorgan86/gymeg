import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb,readFile,stripUnavailableExtensions} from './db-bootstrap-helpers.mjs';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {postgresBackend,firestoreBackend,readSlice,readRevisionOnly,MAX_SLICE}=await import('../app/lib/workspace-slice.ts');
const {splitState,assembleState}=await import('../app/lib/entity-state.ts');
const {memberView}=await import('../app/lib/member-view.ts');
const {normalize}=await import('../app/lib/extensions.ts');
const {readMemberSlice}=await import('../app/lib/workspace-slice.ts');
const {packet,packetQueries}=await import('../app/lib/workspace-packet.ts');
const {emptyState}=await import('../app/lib/domain.ts');

function club(owner){
  const s=emptyState();s.branches=[{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'}];
  const rows=(n,fn)=>Array.from({length:n},(_,i)=>fn(i));
  s.members=rows(60,i=>({id:`m${i}`,name:`Member ${i}`,branch:'abc'[i%3],phone:`+2010000${String(i).padStart(4,'0')}`,photo:i===0?'data:image/png;base64,AAAA':undefined}));
  s.visits=rows(600,i=>({id:`v${i}`,member:`m${i%60}`,branch:'abc'[i%3],at:new Date(2026,0,1,0,i).toISOString(),leftAt:new Date(2026,0,1,1,i).toISOString()}));
  s.payments=rows(120,i=>({id:`p${i}`,member:`m${i%60}`,branch:'abc'[i%3],amount:100}));
  return s;
}
async function seedPg(db,owner,state){
  const {metadata,entities,photos}=splitState(state);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,7,$3)',[owner,JSON.stringify(metadata),new Date().toISOString()]);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  for(const [id,content] of Object.entries(photos))await db.query('INSERT INTO gymos.gym_photos(owner_id,member_id,content) VALUES($1,$2,$3)',[owner,id,content]);
}
function counted(db){const stat={queries:0,rows:0};const scope=async(owner,work)=>work({query:async(sql,values)=>{await db.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);const r=await db.query(sql,values);stat.queries++;stat.rows+=r.rows.length;return r;}});return{stat,backend:postgresBackend(scope)};}
const ids=(rows)=>rows.map(r=>r.entity_id);

test('Postgres slices read only what is asked, scoped to branch, owner and page',async()=>{
  const db=await bootstrapDb();
  try{
    await seedPg(db,'club1',club());await seedPg(db,'club2',club());
    const {stat,backend}=counted(db);
    assert.equal(await readRevisionOnly(backend,'club1'),7);
    assert.deepEqual({q:stat.queries,r:stat.rows},{q:1,r:1},'revision costs one row');
    assert.equal(await readRevisionOnly(backend,'nobody'),null);

    stat.rows=0;const meta=await readSlice(backend,'club1',null);
    assert.equal(stat.rows,1,'settings read touches only the state row');
    assert.equal(meta.state.members.length,0);assert.equal(meta.state.branches.length,3);assert.equal(meta.revision,7);

    stat.rows=0;const members=await readSlice(backend,'club1',{collections:['members'],branches:['a']});
    assert.equal(members.state.members.length,20);assert.ok(members.state.members.every(m=>m.branch==='a'));assert.equal(members.state.visits.length,0);
    assert.equal(stat.rows,21,'20 branch-a members + 1 state row, not 480 entities');
    assert.equal(members.state.members[0].photo,undefined,'photos stay out of list reads');

    const one=await readSlice(backend,'club1',{collections:['members'],ids:['m5']});
    assert.deepEqual(one.state.members.map(m=>m.id),['m5']);

    const page1=await backend.entities('club1',{collections:['visits'],desc:true,limit:50});
    assert.deepEqual(ids(page1).slice(0,2),['v599','v598']);assert.equal(page1.length,50);
    const page2=await backend.entities('club1',{collections:['visits'],desc:true,limit:50,before:page1.at(-1).position});
    assert.equal(page2[0].entity_id,'v549');assert.equal(new Set([...ids(page1),...ids(page2)]).size,100,'pages do not overlap');
    const asc=await backend.entities('club1',{collections:['payments'],after:9,limit:3});
    assert.deepEqual(ids(asc),['p10','p11','p12']);

    assert.equal((await backend.entities('club1',{collections:['visits'],branches:[]})).length,0,'empty branch scope reads nothing');
    assert.equal((await backend.entities('club1',{collections:['visits'],limit:99999})).length,MAX_SLICE,'page size is capped');
    assert.equal(await backend.count('club1','visits',['b']),200);
    assert.equal(await backend.photo('club1','m0'),'data:image/png;base64,AAAA');assert.equal(await backend.photo('club1','m1'),null);
    await assert.rejects(()=>backend.entities('club1',{collections:['nope']}));
    await assert.rejects(()=>backend.entities('club1',{collections:['members','visits'],ids:['x']}));
  }finally{await db.close();}
});

test('Legacy single-payload clubs return null so callers fall back to the full read',async()=>{
  const db=await bootstrapDb();
  try{
    await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('old','{\"members\":[]}',1,'x')");
    const {backend}=counted(db);
    assert.equal(await readSlice(backend,'old',{collections:['members']}),null);
  }finally{await db.close();}
});

// Minimal Firestore double that counts documents returned.
function fakeFs(owner,state){
  const docs=new Map();const {metadata,entities,photos}=splitState(state);
  docs.set(`gym_states/${owner}`,{payload:JSON.stringify(metadata),revision:3});
  for(const e of entities)docs.set(`gym_entities/${owner}_${e.collection}_${e.entity_id}`,{owner_id:owner,...e});
  for(const [id,c] of Object.entries(photos))docs.set(`gym_photos/${owner}_${id}`,{owner_id:owner,member_id:id,content:c});
  const stat={docs:0};
  const make=(name,filters=[],order,dir,start,lim)=>({
    doc:id=>({get:async()=>{const d=docs.get(`${name}/${id}`);if(d)stat.docs++;return{exists:Boolean(d),data:()=>d};}}),
    where:(f,op,v)=>make(name,[...filters,[f,op,v]],order,dir,start,lim),
    orderBy:(f,d='asc')=>make(name,filters,f,d,start,lim),
    startAfter:v=>make(name,filters,order,dir,v,lim),
    limit:n=>make(name,filters,order,dir,start,n),
    get:async()=>{let r=[...docs].filter(([p])=>p.startsWith(name+'/')).map(([,d])=>d).filter(d=>filters.every(([f,op,v])=>op==='=='?d[f]===v:op==='in'?v.includes(d[f]):op==='>'?d[f]>v:op==='<'?d[f]<v:true));
      if(order)r.sort((a,b)=>dir==='desc'?b[order]-a[order]:a[order]-b[order]);
      if(start!==undefined)r=r.filter(d=>dir==='desc'?d[order]<start:d[order]>start);
      if(lim)r=r.slice(0,lim);stat.docs+=r.length;return{docs:r.map(d=>({data:()=>d}))};},
  });
  return{stat,db:{collection:n=>make(n)}};
}
test('Firestore slices read documents by id, branch and page, never the whole club',async()=>{
  const {stat,db}=fakeFs('club1',club());const be=firestoreBackend(()=>db);
  assert.equal(await readRevisionOnly(be,'club1'),3);assert.equal(stat.docs,1);
  stat.docs=0;const one=await readSlice(be,'club1',{collections:['members'],ids:['m5','m6','nope']});
  assert.deepEqual(one.state.members.map(m=>m.id).sort(),['m5','m6']);assert.equal(stat.docs,3,'state + 2 member docs');
  stat.docs=0;const page=await readSlice(be,'club1',{collections:['visits'],branches:['b'],desc:true,limit:25});
  assert.equal(page.state.visits.length,25);assert.ok(page.state.visits.every(v=>v.branch==='b'));assert.equal(stat.docs,26,'25 visits + state doc, not 480+');
  const next=await be.entities('club1',{collections:['visits'],branches:['b'],desc:true,limit:25,before:Math.min(...(await be.entities('club1',{collections:['visits'],branches:['b'],desc:true,limit:25})).map(e=>e.position))});
  assert.equal(next.length,25);
  assert.equal(await be.photo('club1','m0'),'data:image/png;base64,AAAA');
});

function richClub(){
  const s=normalize(emptyState());s.branches=[{id:'a',name:'A'},{id:'b',name:'B'}];
  const day=i=>`2026-02-${String(1+i%27).padStart(2,'0')}`;
  s.members=Array.from({length:12},(_,i)=>({id:`m${i}`,name:`Member ${i}`,branch:i%2?'b':'a',phone:`+2010000000${i}`,periods:[{id:`per${i}`,plan:'pl-'+(i%2?'b':'a'),start:'2026-01-01',end:'2026-12-31',minor:1000,days:365}],shift:i%2?'sh-b':'sh-a'}));
  s.plans=[{id:'pl-a',name:'Gold A',days:30,visits:null,minor:1000,branch:'a',archived:false},{id:'pl-b',name:'Gold B',days:30,visits:null,minor:900,branch:'b',archived:false}];
  s.shifts=[{id:'sh-a',name:'Morning A',branch:'a'},{id:'sh-b',name:'Morning B',branch:'b'}];
  s.visits=Array.from({length:240},(_,i)=>({id:`v${i}`,member:`m${i%12}`,branch:(i%12)%2?'b':'a',day:day(i),at:`${day(i)}T0${i%9}:00:00.000Z`,leftAt:`${day(i)}T1${i%9}:00:00.000Z`}));
  s.payments=Array.from({length:60},(_,i)=>({id:`p${i}`,member:`m${i%12}`,branch:(i%12)%2?'b':'a',minor:500+i,day:day(i),method:'cash',voided:i%17===0,creditable:i%3===0}));
  s.invoices=Array.from({length:24},(_,i)=>({id:`i${i}`,member:`m${i%12}`,branch:(i%12)%2?'b':'a',title:'T',total:700,due:day(i),voided:i%11===0,allocations:i%2?[{payment:`p${i}`,minor:100}]:[]}));
  s.classes=Array.from({length:40},(_,i)=>({id:`c${i}`,title:`Class ${i}`,branch:i%2?'b':'a',at:`2026-03-${String(1+i%27).padStart(2,'0')}T10:00:00.000Z`,members:[`m${i%12}`,`m${(i+2)%12}`],waitlist:[`m${(i+4)%12}`],cancelled:false,price:5,minutes:60}));
  s.programs=[{id:'pr-a',branch:'a',name:'Prog A',days:[]},{id:'pr-b',branch:'b',name:'Prog B',days:[]}];
  s.trainingAssignments=[{id:'ta0',member:'m0',program:'pr-a',start:'2026-01-01',end:null,notes:'',active:true,branch:'a'},{id:'ta1',member:'m1',program:'pr-b',start:'2026-01-01',end:null,notes:'',active:true,branch:'b'}];
  s.trainingSessions=Array.from({length:20},(_,i)=>({id:`ts${i}`,assignment:i%2?'ta1':'ta0',day:i%7,date:day(i),note:'',branch:i%2?'b':'a'}));
  s.coaching=[{id:'co0',member:'m0',branch:'a',title:'PT'}];
  s.community={posts:[{id:'po0',branch:'a',enabled:true,title:'Hi',body:'B',publishAt:'2026-01-01T00:00:00.000Z'}],messages:[{id:'ms0',branch:'a',member:'m0',text:'x',side:'member',at:'2026-01-02T00:00:00.000Z'}]};
  return s;
}
const view=(state,id)=>{const m=state.members.find(x=>x.id===id);try{return JSON.stringify(memberView(state,id,m?m.branch:'a','2026-03-15T12:00:00.000Z'));}catch(e){return 'ERR:'+e.message;}};

test('Member portal view from a slice equals the view from the full state, with far fewer rows (Postgres)',async()=>{
  const db=await bootstrapDb();
  try{
    const full=richClub();await seedPg(db,'club1',full);
    const {stat,backend}=counted(db);
    const everything=await backend.entities('club1',{collections:['members','visits','payments','invoices','classes','plans','shifts','programs','trainingAssignments','trainingSessions','coaching']});
    const meta=await backend.meta('club1');
    const baseline=normalize(assembleState(meta.metadata,everything,{}));
    let sliceRows=0;
    for(let i=0;i<12;i++){
      stat.rows=0;const sliced=await readMemberSlice(backend,'club1',`m${i}`,i%2?'b':'a',normalize);sliceRows=stat.rows;
      assert.equal(view(sliced.state,`m${i}`),view(baseline,`m${i}`),`member m${i} view differs`);
      assert.notEqual(view(baseline,`m${i}`).startsWith('ERR'),true);
    }
    console.log("MEASURE member-view rows",sliceRows,"of",everything.length);
    assert.ok(sliceRows<everything.length/2,`slice read ${sliceRows} rows vs ${everything.length}`);
    const wrongBranch=await readMemberSlice(backend,'club1','m0','b',normalize);
    assert.equal(view(wrongBranch.state,'m0'),'ERR:notFound','a member is invisible through another branch');
    const other=await readMemberSlice(backend,'club2','m0','a',normalize);
    assert.equal(other,null,'other club has no state, nothing leaks across owners');
  }finally{await db.close();}
});

test('Packet built from role-scoped slices equals the packet from the full state, for every role',async()=>{
  const db=await bootstrapDb();
  try{
    const full=richClub();
    full.events=Array.from({length:300},(_,i)=>({id:`e${i}`,at:`2026-02-01T00:${String(i%60).padStart(2,'0')}:00.000Z`,kind:'x',subject:'s',actor:'u',branch:i%2?'b':'a'}));
    full.receipts=Array.from({length:200},(_,i)=>({id:`r${i}`,digest:'d'}));
    full.products=[{id:'pd0',name:'P',branch:'a',photo:'data:image/jpeg;base64,QQ=='}];
    full.followUps=[{id:'f0',member:'m0',branch:'a'}];
    full.members[0].photo='data:image/jpeg;base64,/9j/AAAA';full.members[3].photo='data:image/jpeg;base64,/9j/BBBB';
    full.settings.receptionGrants={rec2:['payment.add']};
    await seedPg(db,'club1',full);
    const {stat,backend}=counted(db);
    const everything=await backend.entities('club1',{collections:['members','visits','payments','invoices','classes','plans','shifts','programs','trainingAssignments','trainingSessions','coaching','events','receipts','products','followUps']});
    const meta=await backend.meta('club1');const photos=Object.fromEntries([['m0',full.members[0].photo],['m3',full.members[3].photo]]);
    const baseline=()=>normalize(assembleState(structuredClone(meta.metadata),structuredClone(everything),structuredClone(photos)));
    const versions=await backend.photoVersions('club1');
    const base={tenantId:'club1',owner:'club1',license:null,support:undefined};
    const ctxs={
      owner:{...base,role:'owner',branches:null,user:{userId:'u1',displayName:'U'}},
      manager:{...base,role:'manager',branches:['a'],user:{userId:'u2',displayName:'U'}},
      noBranches:{...base,role:'manager',branches:[],user:{userId:'u2',displayName:'U'}},
      receptionBare:{...base,role:'reception',branches:['b'],user:{userId:'rec1',displayName:'R'}},
      receptionGrant:{...base,role:'reception',branches:['a','b'],user:{userId:'rec2',displayName:'R'}},
    };
    for(const [name,ctx] of Object.entries(ctxs)){
      const expected=packet({state:baseline(),revision:7},ctx);
      stat.rows=0;
      const sliced=await readSlice(backend,'club1',m=>packetQueries(ctx,m.settings),normalize);
      const rows=stat.rows;
      const got=packet({state:sliced.state,revision:sliced.revision},ctx,versions);
      expected.serverNow=got.serverNow=0;
      assert.deepEqual(JSON.parse(JSON.stringify(got)),JSON.parse(JSON.stringify(expected)),`packet differs for ${name}`);
      console.log('MEASURE packet',name,'rows',rows,'of',everything.length+1);
    }
    assert.match(JSON.stringify(packet({state:(await readSlice(backend,'club1',m=>packetQueries(ctxs.owner,m.settings),normalize)).state,revision:7},ctxs.owner,versions).state.members[0].photo),/member-photo.*v=/);
  }finally{await db.close();}
});
