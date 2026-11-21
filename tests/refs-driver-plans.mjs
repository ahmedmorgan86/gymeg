import pg from '/tmp/gymeg/node_modules/pg/lib/index.js';
const {readReportPaymentsRefs}=await import('/tmp/gymint/app/lib/report-payments-page.ts');
const cl=new pg.Client({host:'/tmp/pgdata',user:'postgres',database:'rehearsal_w'});await cl.connect();
const fx=`insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload)
select 'R','members','m'||g,g,'a',jsonb_build_object('id','m'||g,'name','Name '||g) from generate_series(1,2000) g;
insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload)
select 'R','payments','p'||g,g,'a',jsonb_build_object('id','p'||g,'day','2026-03-'||lpad((1+g%28)::text,2,'0'),'member','m'||(1+g%2000),'method','cash','voided',false) from generate_series(1,40000) g;
insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload)
select 'R','invoices','i'||g,g,'a',jsonb_build_object('id','i'||g,'category','membership','voided',false,'allocations',jsonb_build_array(jsonb_build_object('payment','p'||g,'minor',100),jsonb_build_object('payment','p'||(g%40000+1),'minor',50))) from generate_series(1,40000) g;
insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload)
select 'R','invoices','bulk',50000,'a',jsonb_build_object('id','bulk','category','coaching','voided',false,'allocations',(select jsonb_agg(jsonb_build_object('payment','p'||g,'minor',1,'note',repeat('x',100))) from generate_series(1,20000) g));
analyze gymos.gym_entities;`;
await cl.query("delete from gymos.gym_entities where owner_id='R'; delete from gymos.gym_states where user_id='R'; delete from gymos.invoice_allocation_refs_state where owner_id='R'; insert into gymos.gym_states(user_id,payload,revision,updated_at) values('R','{}',1,'x')");await cl.query(fx);await cl.query("select gymos.invoice_allocation_refs_complete('R',NULL)");console.log('mismatches',(await cl.query("select gymos.invoice_allocation_refs_mismatches('R') n")).rows[0].n);
if(process.env.RLS){await cl.query('SET ROLE gymos_app');await cl.query("SELECT set_config('app.gym_owner','R',false)");}
const log=[];
const c={query:async(sql,v)=>{
  if(/owner_version|SELECT version FROM|to_regclass/.test(sql)&&!/gym_entities/.test(sql))return{rows:[{version:'1',ok:true}]};
  if(/set_config|current_setting/.test(sql)){const r=await cl.query(sql,v);return r;}
  log.push([sql,v]);return cl.query(sql,v);}};
const t0=Date.now();
const out=await readReportPaymentsRefs((o,w)=>w(c),{owner:'R',branch:'a',branches:null,from:'2026-03-01',to:'2026-03-31'});
console.log('status',out.status,'rows',out.rows?.length,'ms',Date.now()-t0);
let txt='';
for(const [sql,v] of log){ 
  const r=await cl.query('EXPLAIN (ANALYZE,BUFFERS,COSTS OFF,TIMING OFF) '+sql,v);
  txt+='-- statement captured from readReportPayments through the node-postgres driver; bound values: '+JSON.stringify(v).slice(0,200)+'...\n'+r.rows.map(x=>x['QUERY PLAN']).join('\n')+'\n\n';}
import fs from 'fs';fs.writeFileSync('/downloads/report-payments-refs-driver-plans'+(process.env.RLS?'-rls':'')+'.txt',txt);
if(process.env.RLS)await cl.query('RESET ROLE');await cl.query("delete from gymos.gym_entities where owner_id='R'; delete from gymos.gym_states where user_id='R'; delete from gymos.invoice_allocation_refs_state where owner_id='R'");await cl.end();
console.log(txt.split('\n').filter(l=>/Execution Time|Planning Time|^ *Buffers: shared/.test(l)).slice(0,8).join('\n'));
