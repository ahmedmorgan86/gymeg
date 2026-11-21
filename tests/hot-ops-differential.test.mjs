import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {applyOperation,emptyState}=await import('../app/lib/domain.ts');
const {normalize}=await import('../app/lib/extensions.ts');
const {splitState,entityChanges}=await import('../app/lib/entity-state.ts');
const {hotPlan,partialState}=await import('../app/lib/hot-op-plans.ts');

function rng(seed){let x=seed>>>0||1;return()=>{x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;return x/4294967296;};}
const NOW='2026-03-15T12:00:00.000Z',DAY='2026-03-15';
function club(seed){
  const r=rng(seed),pick=a=>a[Math.floor(r()*a.length)],s=normalize(emptyState());
  s.branches=[{id:'a',name:'A'},{id:'b',name:'B'}];s.settings.timezone='Africa/Cairo';
  s.plans=[{id:'pl-a',name:'A',days:30,visits:null,minor:1000,branch:'a',archived:false},{id:'pl-b',name:'B',days:30,visits:8,minor:900,branch:'b',archived:false}];
  s.shifts=[{id:'sh-a',name:'M',branch:'a'},{id:'sh-b',name:'M',branch:'b'}];
  if(r()<.4)s.settings.reception={autoExitMinutes:pick([30,120,600]),warningDays:5,blockDebt:r()<.5};
  const N=8+Math.floor(r()*10);
  s.members=Array.from({length:N},(_,i)=>{const b=r()<.6?'a':'b',q=r()<.3;return{id:'m'+i,name:'M '+i,phone:'0100000000'+i,branch:b,joined:'2026-01-01',expires:pick(['2026-03-10','2026-12-31']),archived:r()<.1,demo:false,
    membershipPeriods:r()<.85?[{id:'p'+i,plan:'pl-'+b,start:'2026-01-01',end:'2026-12-31',visits:q?pick([1,2,3]):null,quotaMode:q&&r()<.5?'sessions':undefined}]:undefined,
    freezes:r()<.1?[{from:'2026-03-10',to:'2026-03-20'}]:undefined};});
  let n=0;const day=()=>pick(['2026-03-01','2026-03-05','2026-03-14','2026-03-15']);
  for(const m of s.members)for(let k=0;k<Math.floor(r()*5);k++){const d=day(),open=r()<.3,hh=pick(['06','09','11']);s.visits.push({id:'v'+n++,member:m.id,branch:r()<.9?m.branch:(m.branch==='a'?'b':'a'),day:d,at:`${d}T${hh}:00:00.000Z`,leftAt:open?undefined:`${d}T${hh}:50:00.000Z`,sessions:r()<.2?[{}]:undefined});}
  let pn=0,inv=0;s.payments=[];s.invoices=[];
  for(const m of s.members)for(let k=0;k<Math.floor(r()*3);k++){const pid='pay'+pn++;s.payments.push({id:pid,member:m.id,branch:m.branch,minor:100+Math.floor(r()*500),day:DAY,method:'cash',voided:r()<.1});
    s.invoices.push({id:'inv'+inv++,member:m.id,branch:m.branch,title:'T',total:pick([300,700]),due:DAY,voided:r()<.1,allocations:r()<.5?[{payment:pid,minor:100}]:[]});}
  return s;
}
const strip=x=>JSON.parse(JSON.stringify(x));
function run(state,op){
  let k=0;const nid=()=>'new-'+(k++)+'-aaaaaaaaaaaaaaaaaaaaaaaa';
  const before=splitState(state).entities;
  try{const next=applyOperation(structuredClone(state),op,NOW,'tester',nid);const after=splitState(next).entities;const c=entityChanges(before,after);
    const key=e=>e.collection+':'+e.entity_id;
    // positions differ between full and partial arrays by design; compare identity and payload
    return{ok:true,upserts:c.upserts.map(e=>[key(e),strip(e.payload),e.branch]).sort((a,b)=>a[0]<b[0]?-1:1),removed:c.removed.map(key).sort()};}
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
