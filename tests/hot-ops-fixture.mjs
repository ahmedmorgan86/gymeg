import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {emptyState}=await import('../app/lib/domain.ts');
const {normalize}=await import('../app/lib/extensions.ts');
function rng(seed){let x=seed>>>0||1;return()=>{x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;return x/4294967296;};}
export const NOW='2026-03-15T12:00:00.000Z',DAY='2026-03-15';
export function club(seed){
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
  // Distinctive rows in collections and metadata the hot operations should NOT need. If a plan ever depended on
  // one of them, full and partial runs would diverge (an all-empty fixture cannot show that).
  s.members.push({id:'demo1',name:'Demo',phone:'01099999999',branch:'a',joined:'2026-01-01',expires:'2026-12-31',archived:false,demo:true});
  s.payments.push({id:'demo-pay',member:'demo1',branch:'a',minor:999,day:DAY,method:'cash',voided:false});
  s.shopSales=[{id:'sale1',branch:'a',method:'cash',total:500,lines:[{price:250,quantity:2}],returns:[],voided:false,at:NOW}];
  s.coachPayouts=[{id:'cp1',branch:'a',method:'cash',minor:300}];
  s.classes=[{id:'c1',title:'C',at:'2026-03-16T10:00:00.000Z',capacity:5,members:s.members.slice(0,2).map(m=>m.id),waitlist:[],branch:'a',cancelled:false,price:50}];
  s.followUps=[{id:'f1',member:s.members[0].id,branch:'a'}];
  s.receipts=Array.from({length:50},(_,i)=>({id:'u:r'+i,digest:'d'+i}));
  s.events=Array.from({length:1990},(_,i)=>({id:'ev'+i,at:'2026-03-01T00:00:00.000Z',kind:'x',subject:'s',actor:'u',branch:i%2?'a':'b'}));
  s.financeBook={expenses:[],purchases:[],supplierPayments:[],shifts:[{id:'shift-a',branch:'a',openedAt:'2026-03-15T06:00:00.000Z',opening:1000,actor:'u',note:''},{id:'shift-b',branch:'b',openedAt:'2026-03-15T06:00:00.000Z',opening:500,actor:'u',note:''}],movements:[{id:'mv0',branch:'a',shift:'shift-a',source:'receipt:old',minor:100,kind:'payment.add',at:'2026-03-15T07:00:00.000Z',actor:'u'}]};
  return s;
}
