import {registerHooks} from 'node:module';
const {emptyState}=await import('../app/lib/domain.ts');
const {normalize}=await import('../app/lib/extensions.ts');
export function fixture(){
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
