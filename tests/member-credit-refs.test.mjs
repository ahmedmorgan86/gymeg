import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({
  resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
  load(url,ctx,next){if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__hotDb.query(sql,v),release(){}})});export const isFirebaseConfigured=()=>false;`};return next(url,ctx);}
});
const {splitState}=await import('../app/lib/entity-state.ts');
const {fixture}=await import('./member-summary-fixture.mjs');
const {memberCredit}=await import('../app/lib/member-ledger.ts');
const {allocatingInvoicesFromRefs}=await import('../app/lib/member-credit-refs.ts');
async function seed(owner,state,complete=true){
  const {metadata,entities}=splitState(structuredClone(state));
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  if(complete)await db.query("SELECT gymos.invoice_allocation_refs_complete($1,(SELECT ((payload::jsonb)->'generation')::text FROM gymos.gym_states WHERE user_id=$1))",[owner]);
}
let sd=7;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const scopeC=o=>db; // pglite query surface
test('refs-derived member credit == legacy memberCredit for every member, incl foreign branch/member allocating invoices, voided truthiness, raw minor shapes, order',async()=>{
  const s=fixture();s.branches.push({id:'c',name:'C'});for(const m of s.members)m.branch=pick(['a','b','c']);
  s.visits=[];s.payments=[];s.invoices=[];let pn=0;
  for(let k=0;k<220;k++){const m=pick(s.members);s.payments.push({id:'p'+pn++,member:rnd()<.05?'ghost':m.id,branch:m.branch,minor:100+Math.floor(rnd()*9000)+(rnd()<.2?0.37:0),day:'2026-03-05',method:'cash',voided:rnd()<.1,...(rnd()<.7?{creditable:true}:{})});}
  const minors=[()=>50+Math.floor(rnd()*200),()=>0.1,()=>0.2,()=>7.35,()=>null,()=>(rnd()<.015?'5':3),()=>undefined,()=>-30,()=>1e21,()=>true,()=>50+Math.floor(rnd()*200)];
  for(let k=0;k<500;k++){const m=pick(s.members),allocs=[];for(let a=0;a<1+Math.floor(rnd()*3);a++){const p=pick(s.payments);const mn=pick(minors)();const al={payment:rnd()<.05?'nope':p.id};if(mn!==undefined)al.minor=mn;allocs.push(al);}
    s.invoices.push({id:'i'+k,member:rnd()<.5?m.id:pick(s.members).id,title:'T',total:5000,due:'2026-03-20',branch:pick(['a','b','c']),allocations:allocs,...(rnd()<.15?{voided:pick([true,1,'x',false,0,'',null])}:{})});}
  await seed('C1',s);
  let compared=0,differ=0,refused=0;
  for(const m of s.members){
    const mine=s.payments.filter(p=>p.member===m.id&&p.branch===m.branch);
    const legacy=memberCredit(s,m.id,m.branch);
    const ids=mine.filter(p=>p.creditable&&!p.voided).map(p=>p.id);
    const r=await allocatingInvoicesFromRefs(db,'C1',ids);if(r.status!=='ok'){assert.equal(r.reason,'non-numeric-minor');refused++;continue;}
    const viaRefs=memberCredit({payments:mine,invoices:r.invoices},m.id,m.branch);
    compared++;if(!Object.is(legacy,viaRefs)){differ++;console.log('DIFF',m.id,legacy,viaRefs);}
  }
  assert.equal(differ,0);assert.ok(compared>=5);console.log('compared',compared,'refused(non-numeric minor)',refused);
});
test('refusals: not ready, odd shape in ANY branch, non-string payment id; empty id list needs no readiness',async()=>{
  const s=fixture();s.visits=[];s.payments=[{id:'p1',member:s.members[0].id,branch:s.members[0].branch,minor:900,day:'2026-03-05',method:'cash',creditable:true}];
  s.invoices=[{id:'i1',member:s.members[0].id,title:'T',total:5,due:'2026-03-20',branch:s.members[0].branch,allocations:[{payment:'p1',minor:100}]}];
  await seed('C2',s,false);
  assert.deepEqual(await allocatingInvoicesFromRefs(db,'C2',['p1']),{status:'unavailable',reason:'refs-not-ready'});
  {const e=await allocatingInvoicesFromRefs(db,'C2',[]);assert.equal(e.status,'ok');assert.deepEqual(e.invoices,[]);}
  await db.query("SELECT gymos.invoice_allocation_refs_complete('C2',(SELECT ((payload::jsonb)->'generation')::text FROM gymos.gym_states WHERE user_id='C2'))");
  assert.equal((await allocatingInvoicesFromRefs(db,'C2',['p1'])).status,'ok');
  assert.deepEqual(await allocatingInvoicesFromRefs(db,'C2',[5]),{status:'unavailable',reason:'payment-id'});
  const s3=structuredClone(s);s3.invoices.push({id:'iodd',member:'z',title:'T',total:5,due:'x',branch:'zzz',allocations:'nope'});await seed('C3',s3);
  assert.deepEqual(await allocatingInvoicesFromRefs(db,'C3',['p1']),{status:'unavailable',reason:'unsupported-allocation-shape'});
});
test('targeted: float order, string/null/missing minor, voided truthiness, foreign member and branch invoices',async()=>{
  const s=fixture();s.visits=[];const m=s.members[0];const other=s.members[1];
  s.payments=[{id:'pf',member:m.id,branch:m.branch,minor:1,day:'2026-03-05',method:'cash',creditable:true},{id:'ps',member:m.id,branch:m.branch,minor:1000,day:'2026-03-05',method:'cash',creditable:true},{id:'pn',member:m.id,branch:m.branch,minor:1000,day:'2026-03-05',method:'cash',creditable:true},{id:'pv',member:m.id,branch:m.branch,minor:1000,day:'2026-03-05',method:'cash',creditable:true}];
  const inv=(id,mem,br,allocations,extra={})=>({id,member:mem,title:'T',total:5,due:'2026-03-20',branch:br,allocations,...extra});
  s.invoices=[inv('i1',other.id,'zzz',[{payment:'pf',minor:0.1}]),inv('i2',m.id,m.branch,[{payment:'pf',minor:0.2}]),inv('i3',other.id,m.branch,[{payment:'pf',minor:0.3},{payment:'ps',minor:'5'}]),
    inv('i4',m.id,'q',[{payment:'ps',minor:3}]),inv('i5',m.id,m.branch,[{payment:'pn',minor:null},{payment:'pn'},{payment:'pn',minor:7}]),
    inv('i6',m.id,m.branch,[{payment:'pv',minor:400}],{voided:'0'}),inv('i7',m.id,m.branch,[{payment:'pv',minor:300}],{voided:0}),inv('i8',m.id,m.branch,[{payment:'pv',minor:200}],{voided:null}),inv('i9',m.id,m.branch,[{payment:'pv',minor:100}],{voided:false})];
  await seed('C4',s);
  const ids=['pf','pn','pv'];const r=await allocatingInvoicesFromRefs(db,'C4',ids);assert.equal(r.status,'ok');
  const sub=s.payments.filter(p=>ids.includes(p.id));const legacy=memberCredit({...s,payments:sub},m.id,m.branch),viaRefs=memberCredit({payments:sub,invoices:r.invoices},m.id,m.branch);
  assert.ok(Object.is(legacy,viaRefs),legacy+' vs '+viaRefs);
  // the oracle values themselves are non-trivial (order-, coercion- and truthiness-sensitive)
  const pfOnly=s.payments.filter(p=>p.id==='pf'),rf=await allocatingInvoicesFromRefs(db,'C4',['pf']);assert.ok(!Object.is(memberCredit({payments:pfOnly,invoices:rf.invoices},m.id,m.branch),memberCredit({payments:pfOnly,invoices:[...rf.invoices].reverse()},m.id,m.branch)),'oracle is order-sensitive (float 0.1+0.2+0.3)');
  assert.deepEqual(r.invoices.map(i=>i.allocations.length),[1,1,1,3,1,1,1,1]);
  assert.deepEqual(await allocatingInvoicesFromRefs(db,'C4',['ps']),{status:'unavailable',reason:'non-numeric-minor'});
  for(const pid of ['pf','pn','pv']){const p=s.payments.filter(x=>x.id===pid);const rr=await allocatingInvoicesFromRefs(db,'C4',[pid]);assert.ok(Object.is(memberCredit(s,m.id,m.branch)-0,legacy-0));assert.ok(Object.is(memberCredit({...s,payments:p},m.id,m.branch),memberCredit({payments:p,invoices:rr.invoices},m.id,m.branch)),pid);}
});

const trig=async(on)=>{for(const [tbl,names] of [['gym_entities',['ins','upd','del','trunc']],['gym_states',['epoch_upd','epoch_del','epoch_trunc']]])for(const n of names)await db.query(`ALTER TABLE gymos.${tbl} ${on?'ENABLE ALWAYS':'DISABLE'} TRIGGER invoice_allocation_refs_${n}`);};
test('tie at the same position is refused (legacy order undefined); cap; stale version; disabled trigger; empty owner then first invoice',async()=>{
  const s=fixture();s.visits=[];const m=s.members[0];
  s.payments=[{id:'p1',member:m.id,branch:m.branch,minor:900,day:'2026-03-05',method:'cash',creditable:true}];
  const inv=(id,a)=>({id,member:m.id,title:'T',total:5,due:'2026-03-20',branch:m.branch,allocations:[{payment:'p1',minor:a}]});
  s.invoices=[inv('ia',0.1),inv('ib',0.2)];await seed('C5',s);
  const ok=await allocatingInvoicesFromRefs(db,'C5',['p1']);assert.equal(ok.status,'ok');assert.equal(typeof ok.version,'string');
  // same position for both
  await db.query("UPDATE gymos.gym_entities SET position=(SELECT position FROM gymos.gym_entities WHERE owner_id='C5' AND entity_id='ia') WHERE owner_id='C5' AND entity_id='ib'");
  assert.deepEqual(await allocatingInvoicesFromRefs(db,'C5',['p1']),{status:'unavailable',reason:'ambiguous-order'});
  // cap
  assert.deepEqual(await allocatingInvoicesFromRefs(db,'C5',Array.from({length:501},(_,i)=>'x'+i)),{status:'unavailable',reason:'too-many-payment-ids'});
  assert.equal((await allocatingInvoicesFromRefs(db,'C5',Array.from({length:500},(_,i)=>'x'+i))).status,'ok');
  // a caller holding an older version is told 'changed'
  const v=(await allocatingInvoicesFromRefs(db,'C5',[])).version;
  await db.query("UPDATE gymos.gym_entities SET position=position+100 WHERE owner_id='C5' AND entity_id='ib'");
  const after=await allocatingInvoicesFromRefs(db,'C5',['p1'],{ver:v});assert.deepEqual(after,{status:'unavailable',reason:'changed'});
  // disabled maintenance trigger => refuse (writes could skip the refs)
  await trig(false);try{assert.deepEqual(await allocatingInvoicesFromRefs(db,'C5',['p1']),{status:'unavailable',reason:'refs-triggers-disabled'});}finally{await trig(true);}
  assert.equal((await allocatingInvoicesFromRefs(db,'C5',['p1'])).status,'ok');
  // empty owner (no state row, no invoices) reads as ready; the first invoice with no readiness claim makes it unavailable
  assert.equal((await allocatingInvoicesFromRefs(db,'NEWOWNER',['p1'])).status,'unavailable'); // no version row yet: refuses (no-version) rather than guessing
  await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('NEW2',$1,1,'x')",[JSON.stringify({_entityStorage:1,generation:'g'})]);
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('NEW2','invoices','i1',0,'a','{\"id\":\"i1\",\"allocations\":[{\"payment\":\"p1\",\"minor\":1}]}')");
  const first=await allocatingInvoicesFromRefs(db,'NEW2',['p1']);assert.deepEqual(first,{status:'unavailable',reason:first.reason});assert.ok(['refs-not-ready','no-version'].includes(first.reason),first.reason);
  const st=(await db.query("SELECT ready FROM gymos.invoice_allocation_refs_state WHERE owner_id='NEW2'")).rows[0];assert.ok(!st||st.ready===false,'no automatic readiness claim after the first invoice');
});

test('replica-role writers (bulk load / logical-apply style) still maintain refs and tombstone restores because the triggers are ENABLE ALWAYS',async()=>{
  const s=fixture();s.visits=[];const m=s.members[0];s.payments=[{id:'p1',member:m.id,branch:m.branch,minor:900,day:'2026-03-05',method:'cash',creditable:true}];s.invoices=[{id:'i1',member:m.id,title:'T',total:5,due:'2026-03-20',branch:m.branch,allocations:[{payment:'p1',minor:100}]}];
  await seed('C6',s);assert.equal((await allocatingInvoicesFromRefs(db,'C6',['p1'])).invoices.length,1);
  await db.query("SET session_replication_role=replica");
  try{
    await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('C6','invoices','i2',5,$1,$2)",[m.branch,JSON.stringify({id:'i2',allocations:[{payment:'p1',minor:7}]})]);
    assert.equal((await db.query("SELECT count(*)::int n FROM gymos.invoice_allocation_refs WHERE owner_id='C6' AND invoice_id='i2'")).rows[0].n,1,'replica-role insert maintained the refs');
    await db.query("UPDATE gymos.gym_states SET payload=jsonb_set(payload::jsonb,'{generation}','\"restored\"')::text WHERE user_id='C6'");
  }finally{await db.query("SET session_replication_role=origin");}
  assert.equal((await db.query("SELECT ready FROM gymos.invoice_allocation_refs_state WHERE owner_id='C6'")).rows[0].ready,false,'replica-role generation change left the owner unready');
  assert.deepEqual(await allocatingInvoicesFromRefs(db,'C6',['p1']),{status:'unavailable',reason:'refs-not-ready'});
});
