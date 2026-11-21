import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {postgresBackend,readHotSlice,HOT_OPEN_CAP}=await import('../app/lib/workspace-slice.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {normalize}=await import('../app/lib/extensions.ts');
const {hotPlan,partialState}=await import('../app/lib/hot-op-plans.ts');
const {club}=await import('./hot-ops-fixture.mjs');

async function seed(db,owner,state){
  const {metadata,entities}=splitState(state);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,3,$3)',[owner,JSON.stringify(metadata),new Date().toISOString()]);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
function counted(db){const stat={queries:0,rows:0};const scope=async(owner,work)=>work({query:async(sql,values)=>{await db.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);const r=await db.query(sql,values);stat.queries++;stat.rows+=r.rows.length;return r;}});return{stat,backend:postgresBackend(scope)};}
const ids=(s)=>Object.fromEntries(['members','visits','payments','invoices','plans','shifts','classes','events'].map(c=>[c,s[c].map(x=>x.id).sort()]));
const canon=x=>Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const body=s=>JSON.stringify(canon(Object.fromEntries(['members','visits','payments','invoices','plans','shifts'].map(c=>[c,[...s[c]].sort((a,b)=>a.id<b.id?-1:1)]))));

test('SQL hydration returns exactly the rows partialState keeps, for planned operations',async()=>{
  const db=await bootstrapDb();
  try{
    let n=0;
    for(let seed_=1;seed_<=6;seed_++){
      const owner='club'+seed_,full=club(seed_);{const seen=new Set();for(const v of full.visits){if(v.leftAt)continue;if(seen.has(v.member))v.leftAt=v.at.slice(0,11)+'23:00:00.000Z';else seen.add(v.member);}} // DB allows one open visit per member
      await db.query('BEGIN');await seed(db,owner,full);await db.query('COMMIT');
      const {backend}=counted(db);
      const ops=[...full.members.slice(0,4).flatMap(m=>[{type:'payment.add',branch:m.branch,id:m.id},{type:'visit.add',branch:m.branch,id:m.id}]),...full.visits.slice(0,4).map(v=>({type:'visit.exit',branch:v.branch,id:v.id})),{type:'payment.add',branch:'a',id:'nobody'}];
      for(const op of ops){
        const plan=hotPlan(op),want=partialState(normalize(structuredClone(full)),plan),got=await readHotSlice(backend,owner,plan,normalize);
        assert.ok(got,'hydrated');assert.deepEqual(ids(got.state),ids(want),`${owner} ${op.type} ${op.id}`);assert.equal(body(got.state),body(want),`${owner} payloads ${op.type} ${op.id}`);n++;
      }
    }
    console.log('HOT-SLICE parity cases',n);
  }finally{await db.close();}
});

test('Hot hydration cost: member history scales with that member only, stale open visits fall back past the cap',async()=>{
  const db=await bootstrapDb();
  try{
    const mk=(members,visitsPerMember,stalePerMember)=>{const s=club(1);s.members=Array.from({length:members},(_,i)=>({id:'m'+i,name:'M',phone:'0100000000',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[{id:'p'+i,plan:'pl-a',start:'2026-01-01',end:'2026-12-31',visits:null}]}));
      s.payments=[];s.invoices=[];let n=0;s.visits=[];
      for(let i=0;i<members;i++){for(let k=0;k<visitsPerMember;k++)s.visits.push({id:'v'+n++,member:'m'+i,branch:'a',day:'2026-01-01',at:`2026-01-01T0${k%9}:00:00.000Z`,leftAt:'2026-01-01T12:00:00.000Z'});for(let k=0;k<stalePerMember;k++)s.visits.push({id:'v'+n++,member:'m'+i,branch:'a',day:'2026-02-01',at:`2026-02-01T0${k%9}:00:00.000Z`});}return s;};
    const rows=async(owner,state,op)=>{await db.query('BEGIN');await seed(db,owner,state);await db.query('COMMIT');const {stat,backend}=counted(db);const got=await readHotSlice(backend,owner,hotPlan(op),normalize);return{got,rows:stat.rows,queries:stat.queries,total:splitState(state).entities.length};};
    const small=await rows('s1',mk(20,5,0),{type:'payment.add',branch:'a',id:'m3'});
    const manyMembers=await rows('s2',mk(400,5,0),{type:'payment.add',branch:'a',id:'m3'});
    const longHistory=await rows('s3',mk(20,1200,0),{type:'payment.add',branch:'a',id:'m3'});
    const someOpen=await rows('s4',mk(200,2,1),{type:'payment.add',branch:'a',id:'m3'});
    const staleOpen=await rows('s5',mk(2400,0,1),{type:'payment.add',branch:'a',id:'m3'});
    console.log('HOT-SLICE rows',JSON.stringify({small:[small.rows,small.total],manyMembers:[manyMembers.rows,manyMembers.total],longHistory:[longHistory.rows,longHistory.total],someOpen:[someOpen.rows,someOpen.total],staleOpen:[staleOpen.rows,staleOpen.total,staleOpen.got===null]}));
    assert.ok(manyMembers.rows<=small.rows+10,'club size without open visits does not change the read');
    assert.ok(longHistory.got&&longHistory.rows>1200,'a long member history is read in pages, completely');
    assert.equal(someOpen.got.state.visits.filter(v=>!v.leftAt).length,200,'every open visit is loaded');
    assert.equal(staleOpen.got,null,'2400 open visits (the one-open-visit-per-member constraint allows one per member) exceed the cap: full read, never a truncated one');
    assert.ok(HOT_OPEN_CAP<2400);
  }finally{await db.close();}
});
