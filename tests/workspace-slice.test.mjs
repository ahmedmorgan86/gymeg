import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb,readFile,stripUnavailableExtensions} from './db-bootstrap-helpers.mjs';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {postgresBackend,firestoreBackend,readSlice,readRevisionOnly,MAX_SLICE}=await import('../app/lib/workspace-slice.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
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
