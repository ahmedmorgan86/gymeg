import {test} from 'node:test';import assert from 'node:assert/strict';
const {emptyState,dayAt}=await import('../app/lib/domain.ts');const {normalize,membershipIssue}=await import('../app/lib/extensions.ts');
const {computeStoredSummary,deriveSummary}=await import('../app/lib/member-summary-model.ts');
let sd=7;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const addD=(d,k)=>new Date(Date.parse(d)+k*864e5).toISOString().slice(0,10);
test('stored-summary quota status == legacy membershipIssue (sessions/days mode, periodId, branches, future days, freezes)',()=>{
  let compared=0,quota=0,nonNull=0;
  for(let round=0;round<400;round++){
    const s=normalize(emptyState());s.branches=[{id:'a',name:'A'},{id:'b',name:'B'}];s.settings.timezone='Africa/Cairo';
    const P1={id:'p1',plan:'pl',start:'2026-01-01',end:'2026-02-28',visits:pick([1,2,3,5,null]),quotaMode:pick(['sessions','days',undefined])},P2={id:'p2',plan:'pl',start:'2026-03-01',end:'2026-12-31',visits:pick([1,2,3,5,null]),quotaMode:pick(['sessions','days',undefined]),cancelled:rnd()<.1};
    const m={id:'m1',name:'X Y',phone:'01000000001',branch:pick(['a','b']),joined:'2026-01-01',expires:pick(['2026-12-31','2026-03-12']),membershipPeriods:[P1,P2].slice(0,pick([1,2])),freezes:rnd()<.2?[{from:'2026-03-10',to:'2026-03-12'}]:undefined};s.members=[m];
    const days=[];for(let i=-70;i<=12;i++)days.push(addD('2026-03-10',i));
    s.visits=[];let n=0;for(let k=0;k<Math.floor(rnd()*14);k++){const d=pick(days),per=pick([undefined,'p1','p2','zzz']);const v={id:'v'+n++,member:'m1',branch:pick(['a','b']),day:d,at:d+'T0'+(k%9)+':00:00.000Z',leftAt:d+'T0'+(k%9)+':30:00.000Z'};if(per)v.periodId=per;if(rnd()<.4)v.sessions=Array.from({length:Math.floor(rnd()*3)},(_,i)=>({at:d+'T1'+i+':00:00.000Z',leftAt:d+'T1'+i+':30:00.000Z'}));s.visits.push(v);}
    const stamp=pick(['2026-03-10T00:00:00.000Z','2026-03-12T00:00:00.000Z']);
    const stored=computeStoredSummary(s,m,stamp,{allBranches:true});
    for(const now of ['2026-03-10T12:00:00.000Z','2026-03-11T12:00:00.000Z','2026-03-12T12:00:00.000Z','2026-03-13T12:00:00.000Z']){
      const x=deriveSummary(stored,m,s.settings,now);if(!x)continue; // behind the stored horizon: caller falls back to legacy
      const want=membershipIssue(s,m,dayAt(now,s.settings.timezone));
      assert.equal(x.issue,want,`round ${round} now ${now} stamp ${stamp}`);compared++;if(want==='quota')quota++;if(want)nonNull++;
    }
  }
  assert.ok(compared>800&&quota>30&&nonNull>quota,`coverage compared=${compared} quota=${quota} nonNull=${nonNull}`);
});
