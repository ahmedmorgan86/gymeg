import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {applyOperation,emptyState}=await import('../app/lib/domain.ts');
const {normalize}=await import('../app/lib/extensions.ts');
const {splitState,entityChanges}=await import('../app/lib/entity-state.ts');
const {hotPlan,partialState}=await import('../app/lib/hot-op-plans.ts');

const {club,NOW}=await import('./hot-ops-fixture.mjs');
const strip=x=>JSON.parse(JSON.stringify(x));
function run(state,op){
  let k=0;const nid=()=>'new-'+(k++)+'-aaaaaaaaaaaaaaaaaaaaaaaa';
  const before=splitState(state).entities;
  try{const next=applyOperation(structuredClone(state),op,NOW,'tester',nid);const after=splitState(next).entities;const c=entityChanges(before,after);
    const key=e=>e.collection+':'+e.entity_id;
    // positions differ between full and partial arrays by design; compare identity and payload
    const meta=strip(splitState(next).metadata);
    return{ok:true,meta,upserts:c.upserts.map(e=>[key(e),strip(e.payload),e.branch]).sort((a,b)=>a[0]<b[0]?-1:1),removed:c.removed.map(key).sort()};}
  catch(e){return{ok:false,error:e.code??e.message};}
}
function ops(s){
  const out=[];
  for(const m of s.members){out.push({type:'payment.add',branch:m.branch,id:m.id,minor:250,method:'cash'},{type:'visit.add',branch:m.branch,id:m.id});}
  out.push({type:'payment.add',branch:'a',id:'nobody',minor:5,method:'cash'},{type:'visit.add',branch:'b',id:'m0',x:1});
  for(const v of s.visits.slice(0,12))out.push({type:'visit.exit',branch:v.branch,id:v.id});
  out.push({type:'visit.exit',branch:'a',id:'missing'});
  return out;
}
test('hot operations: hydrated partial state gives the same outcome as the full state (randomized clubs)',()=>{
  let n=0,okCount=0,errCount=0;const codes=new Set();
  for(let seed=1;seed<=60;seed++){
    const s=club(seed);
    for(const op of ops(s)){
      const plan=hotPlan(op);assert.ok(plan,'planned: '+op.type);
      const full=run(s,op),part=run(partialState(s,plan),op);
      assert.deepEqual(part,full,`seed ${seed} ${op.type} ${JSON.stringify(op)}`);
      n++;if(full.ok)okCount++;else{errCount++;codes.add(full.error);}
    }
  }
  console.log('DIFFERENTIAL ops',n,'ok',okCount,'rule errors',errCount,[...codes].join(','));
  assert.ok(okCount>200&&errCount>50,'both success and failure paths exercised');
});
test('operations without a plan keep the full read',async()=>{
  const {hotPlan}=await import('../app/lib/hot-op-plans.ts');
  for(const t of ['visit.scan','member.save','plan.assign','member.archive','reception.permissions','backup.restore','class.book'])assert.equal(hotPlan({type:t,branch:'a',id:'x'}),null,t);
});

test('global caps: counts decide the limit at the boundary exactly as the full state does',async()=>{
  const {applyHot}=await import('../app/lib/hot-op-plans.ts');
  const s=club(3);
  // a visit.add that succeeds on the base club
  const op=ops(s).filter(o=>o.type==='visit.add').find(o=>{const r=run(s,o);return r.ok&&r.upserts.some(u=>u[0].startsWith('visits:new-'));});assert.ok(op,'found a visit.add that appends a visit');
  const owner=s.members.find(m=>m.id===op.id);
  for(const total of [99998,99999,100000,100001]){
    const full=structuredClone(s);let k=0;
    const fillers=total-full.visits.length;
    for(let i=0;i<fillers;i++)full.visits.push({id:'f'+i,member:'m1',branch:'b',day:'2026-01-01',at:'2026-01-01T09:00:00.000Z',leftAt:'2026-01-01T10:00:00.000Z'});
    const outcome=fn=>{try{fn();return'ok';}catch(e){return e.code??e.message;}};
    const nid=()=>'nn-'+(k++)+'-aaaaaaaaaaaaaaaaaaaaaaaa';
    const f=outcome(()=>applyOperation(structuredClone(full),op,NOW,'t',nid));
    k=0;
    // the hydrated partial state keeps only the member's rows and open visits; counts come from the whole club
    const part=partialState(full,hotPlan(op));
    const counts={members:full.members.length,visits:full.visits.length,invoices:full.invoices.length,plans:full.plans.length,followUps:full.followUps.length};
    const p=outcome(()=>applyHot(structuredClone(part),counts,op,NOW,'t',nid));
    assert.equal(p,f,`visits=${total}: full=${f} partial=${p}`);
    if(total>=100000)assert.equal(f,'limit');else assert.equal(f,'ok');
  }
});
