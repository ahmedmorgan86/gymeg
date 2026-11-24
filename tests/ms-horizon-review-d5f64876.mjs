import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},load(u,x,n){return n(u,x);}});
const {emptyState}=await import('../app/lib/domain.ts');
const {normalize}=await import('../app/lib/extensions.ts');
const {consoleIndex}=await import('../app/lib/member-console.ts');
const {computeStoredSummary,deriveSummary}=await import('../app/lib/member-summary-model.ts');
let seed=12345;const R=()=>(seed=(seed*1664525+1013904223)>>>0)/2**32;const pick=a=>a[Math.floor(R()*a.length)];
const day=(base,off)=>new Date(Date.parse(base+'T00:00:00Z')+off*86400000).toISOString().slice(0,10);
const TZS=['Africa/Cairo','Pacific/Kiritimati','Etc/GMT+12','America/Los_Angeles','UTC'];
let compared=0,bad=[],nulls=0;
for(let iter=0;iter<300;iter++){
  const tz=pick(TZS);const T=new Date(Date.UTC(2026,2,10,Math.floor(R()*24),Math.floor(R()*60))).toISOString(); // compute clock
  const s=normalize(emptyState());s.settings.timezone=tz;s.branches=[{id:'a',name:'A'},{id:'b',name:'B'}];
  const P=(id,start,end,x={})=>({id,plan:'pl',start,end,visits:null,...x});
  const mk=(i)=>{const b=pick(['a','b']);const per=[P('p'+i,'2026-01-01','2026-12-31',{visits:pick([null,3,6]),quotaMode:pick([undefined,'sessions'])})];if(R()<.3)per.push(P('q'+i,'2026-03-01','2026-03-31',{visits:2,cancelled:R()<.5}));return{id:'m'+i,branch:b,joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:per,freezes:R()<.1?[{from:'2026-03-12',to:'2026-03-13'}]:undefined};};
  s.members=Array.from({length:6},(_,i)=>mk(i));let n=0;
  for(const m of s.members)for(let k=0;k<12;k++){const d=day('2026-03-05',Math.floor(R()*10));const hasPer=R()<.4;s.visits.push({id:'v'+n++,member:m.id,branch:R()<.75?m.branch:pick(['a','b']),day:d,at:d+'T'+String(Math.floor(R()*24)).padStart(2,'0')+':00:00.000Z',leftAt:R()<.9?d+'T23:00:00.000Z':undefined,periodId:hasPer?pick(['p'+m.id.slice(1),'q'+m.id.slice(1),undefined]):undefined,sessions:R()<.4?[{}]:undefined});}
  // one open visit max per member
  for(const m of s.members){const op=s.visits.filter(v=>v.member===m.id&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:30:00.000Z';}
  for(const m of s.members){s.payments.push({id:'p_'+m.id,member:m.id,branch:pick(['a','b']),minor:100,voided:false});s.invoices.push({id:'i_'+m.id,member:m.id,branch:m.branch,total:500,voided:false,allocations:[{payment:'p_'+m.id,minor:100}]});}
  const stored=new Map(s.members.map(m=>[m.id,JSON.parse(JSON.stringify(computeStoredSummary(s,m,T)))]));
  for(let h=-30;h<=80;h+=7){const now=new Date(Date.parse(T)+h*3600000).toISOString();
    for(const br of ['a','b']){const idx=consoleIndex(s,br,now);
      for(const {m,summary} of idx){const d=deriveSummary(stored.get(m.id),m,s.settings,now);
        if(d===null){nulls++;continue;}compared++;
        for(const k of ['issue','used','debt','paid','visitsRemaining','status','remaining'])if(JSON.stringify(d[k])!==JSON.stringify(summary[k])){bad.push({tz,T,now,member:m.id,field:k,console:summary[k],stored:d[k]});break;}
        if(d.last?.id!==summary.last?.id||d.current?.id!==summary.current?.id)bad.push({tz,member:m.id,field:'last/current',now});}}}
}
console.log({compared,nullAnswers:nulls,divergences:bad.length,sample:bad.slice(0,4)});
