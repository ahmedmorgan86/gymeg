// Driver-captured plans (node-postgres, runtime role gymos_app, FORCE RLS) for the screen-slice readers: attendance, today-visits, last-visits, open-visits, dues, payments summary/export.
// Scratch PG16 only. Every statement each reader issued is EXPLAIN (ANALYZE, BUFFERS)ed; plan SHAPE evidence plus individual SQL samples, not app performance.
import pg from '/tmp/gymeg/node_modules/pg/lib/index.js';import fs from 'fs';
const sup=new pg.Client({host:'/tmp/pgdata',user:'postgres',database:'rehearsal_w'});await sup.connect();const S=q=>sup.query(q);
const clean="delete from gymos.gym_entities where owner_id ~ '^(R|S[0-9]+)$'; delete from gymos.gym_states where user_id ~ '^(R|S[0-9]+)$'; delete from gymos.invoice_allocation_refs_state where owner_id ~ '^(R|S[0-9]+)$'";
await S(clean);
const mk=(o,ms,vs,ps,is)=>`insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) select '${o}','members','m'||g,g,(array['a','b','c'])[1+g%3],jsonb_build_object('id','m'||g,'name','Name '||g,'branch',(array['a','b','c'])[1+g%3]) from generate_series(1,${ms}) g;
insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) select '${o}','visits','v'||g,g,(array['a','b','c'])[1+g%3],jsonb_build_object('id','v'||g,'member','m'||(1+g%${ms}),'branch',(array['a','b','c'])[1+g%3],'day',to_char(date '2026-05-01'+(g%180),'YYYY-MM-DD'),'at',to_char(timestamp '2026-05-01 06:00'+((g%180)||' days')::interval+((g%600)||' minutes')::interval,'YYYY-MM-DD"T"HH24:MI:SS".000Z"')) || case when g%50=0 and g<=${ms} then '{}'::jsonb else jsonb_build_object('leftAt',to_char(timestamp '2026-05-01 07:00'+((g%180)||' days')::interval+((g%600)||' minutes')::interval,'YYYY-MM-DD"T"HH24:MI:SS".000Z"')) end from generate_series(1,${vs}) g;
insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) select '${o}','payments','p'||g,g,(array['a','b','c'])[1+g%3],jsonb_build_object('id','p'||g,'day',to_char(date '2026-05-01'+(g%180),'YYYY-MM-DD'),'member','m'||(1+g%${ms}),'branch',(array['a','b','c'])[1+g%3],'method','cash','minor',1000,'voided',false,'creditable',g%5=0) from generate_series(1,${ps}) g;
insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) select '${o}','invoices','i'||g,g,(array['a','b','c'])[1+g%3],jsonb_build_object('id','i'||g,'member','m'||(1+g%${ms}),'branch',(array['a','b','c'])[1+g%3],'total',5000,'voided',false,'due','2026-06-01','allocations',jsonb_build_array(jsonb_build_object('payment','p'||g,'minor',100))) from generate_series(1,${is}) g;`;
await S(mk('R',3000,60000,60000,30000));await S("insert into gymos.gym_states(user_id,payload,revision,updated_at) values('R','{\"_entityStorage\":1,\"generation\":\"g\",\"settings\":{\"timezone\":\"Africa/Cairo\"}}',1,'x')");
for(let i=1;i<=100;i++){await S(mk('S'+i,30,100,100,50));await S(`insert into gymos.gym_states(user_id,payload,revision,updated_at) values('S${i}','{"_entityStorage":1,"generation":"g"}',1,'x')`);}
await S("select gymos.invoice_allocation_refs_complete('R','\"g\"')");
await S('analyze gymos.gym_entities');
const cl=new pg.Client({host:'/tmp/pgdata',user:'postgres',database:'rehearsal_w'});await cl.connect();await cl.query('SET ROLE gymos_app');await cl.query('SET statement_timeout=10000');
const mods={};for(const [k,f] of Object.entries({att:'attendance-page',today:'today-visits',last:'last-visits-page',open:'open-visits-page',dues:'dues-page',pay:'payments-page'}))mods[k]=await import('/tmp/gymint/app/lib/'+f+'.ts');
let txt='fixture: owner R 3000 members, 60000 visits (2% open), 60000 payments, 30000 invoices over branches a,b,c; 100 small owners. Runtime role gymos_app, FORCE RLS.\n\n';const summary=[];
const run=async(label,owner,fn)=>{
  await cl.query("SELECT set_config('app.gym_owner',$1,false)",[owner]);const log=[];
  const c={query:async(sql,v)=>{if(/set_config|current_setting\('app/.test(sql))return cl.query(sql,v);log.push([sql,v]);return cl.query(sql,v);}};
  const t0=Date.now();let out;try{out=await fn((o,w)=>w(c));}catch(e){out={status:'THROWN',reason:String(e.message).slice(0,160)};}const ms=Date.now()-t0;
  txt+=`=== ${label}: owner ${owner} status ${out.status}${out.reason?' '+out.reason:''} total-ms ${ms} statements ${log.length}\n`;const seq=[],nonIdx=[];let maxEx=0;
  for(const [sql,v] of log){let lines;try{lines=(await cl.query('EXPLAIN (ANALYZE,BUFFERS,COSTS OFF,TIMING OFF) '+sql,v)).rows.map(x=>x['QUERY PLAN']);}catch(e){lines=['EXPLAIN failed: '+e.message.slice(0,100)];}
    for(const l of lines){if(/Seq Scan on (gym_entities|invoice_allocation_refs|gym_states)\b/.test(l)&&!/never executed/.test(l))seq.push(l.trim().slice(0,100));const m=l.match(/Execution Time: ([\d.]+)/);if(m)maxEx=Math.max(maxEx,+m[1]);}
    txt+='-- '+sql.replace(/\s+/g,' ').slice(0,160)+' | bound '+JSON.stringify(v??[]).slice(0,100)+'\n'+lines.join('\n')+'\n';}
  txt+='\n';summary.push({label,status:out.status,keys:Object.keys(out).join(','),reason:out.reason,ms,statements:log.length,maxStatementMs:maxEx,seq});};
const day='2026-06-15',B={owner:'R',branch:'a'};
await run('attendance day (first page)','R',s=>mods.att.readAttendance(s,{...B,day}));
await run('attendance, small owner','S50',s=>mods.att.readAttendance(s,{owner:'S50',branch:'a',day}));
await run('today-visits','R',s=>mods.today.readTodayVisits(s,{...B,day}));
await run('last-visits','R',s=>mods.last.readLastVisits(s,{...B,today:day}));
await run('open-visits','R',s=>mods.open.readOpenVisits(s,B));
await run('dues first page, active branch a','R',s=>mods.dues.readDues(s,{...B,branches:null}));
await run('dues restricted to branch b','R',s=>mods.dues.readDues(s,{owner:'R',branch:'b',branches:['b']}));
await run('payments summary (period 30)','R',s=>mods.pay.readPaymentsSummary(s,{...B,today:day,period:30}));
await run('payments export first page','R',s=>mods.pay.readPaymentsExport(s,B));
fs.writeFileSync('/downloads/slices-driver-plans-v5-paysum.txt',txt);
console.log(JSON.stringify(summary,null,1));
await cl.query('RESET ROLE');await cl.end();await S(clean);await sup.end();
