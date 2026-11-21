// Driver-captured plans (node-postgres, runtime role gymos_app with FORCE RLS) for the Reports payments refs reader across the scenario matrix:
// restricted single / multiple branches, far keyset page with mixed (canonical + non-canonical) day text, many owners with skew, virgin / unready owners (fallback). Scratch PG16 only; single runs, plan SHAPE evidence, timings are individual SQL samples.
import pg from '/tmp/gymeg/node_modules/pg/lib/index.js';import fs from 'fs';
const {readReportPaymentsRefs}=await import('/tmp/gymint/app/lib/report-payments-page.ts');
const sup=new pg.Client({host:'/tmp/pgdata',user:'postgres',database:'rehearsal_w'});await sup.connect();
const S=q=>sup.query(q);
await S("delete from gymos.gym_entities where owner_id ~ '^(R|S[0-9]+|V[12])$'; delete from gymos.gym_states where user_id ~ '^(R|S[0-9]+|V[12])$'; delete from gymos.invoice_allocation_refs_state where owner_id ~ '^(R|S[0-9]+|V[12])$'");
const mk=(o,ms,ps,is)=>`insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) select '${o}','members','m'||g,g,(array['a','b','c'])[1+g%3],jsonb_build_object('id','m'||g,'name','Name '||g) from generate_series(1,${ms}) g;
insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) select '${o}','payments','p'||g,g,(array['a','b','c'])[1+g%3],jsonb_build_object('id','p'||g,'day',case when g%1200=1199 then (array['2026-3-5','2026-03-05T10:00:00','٢٠٢٦-٠٣-٠٥','x'])[1+g%4] else to_char(date '2026-01-01'+(g%180),'YYYY-MM-DD') end,'member','m'||(1+g%${ms}),'method','cash','voided',false) from generate_series(1,${ps}) g;
insert into gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) select '${o}','invoices','i'||g,g,(array['a','b','c'])[1+g%3],jsonb_build_object('id','i'||g,'category','membership','voided',false,'allocations',jsonb_build_array(jsonb_build_object('payment','p'||g,'minor',100),jsonb_build_object('payment','p'||(g%${ps}+1),'minor',50))) from generate_series(1,${is}) g;`;
await S(mk('R',3000,60000,60000));await S("insert into gymos.gym_states(user_id,payload,revision,updated_at) values('R','{}',1,'x')");
for(let i=1;i<=300;i++){await S(mk('S'+i,50,100,100));await S(`insert into gymos.gym_states(user_id,payload,revision,updated_at) values('S${i}','{}',1,'x')`);}
await S(mk('V1',50,100,100));            // virgin: invoices, no state row
await S(mk('V2',50,100,100));await S("insert into gymos.gym_states(user_id,payload,revision,updated_at) values('V2','{}',1,'x')"); // state row, never completed
await S("select gymos.invoice_allocation_refs_complete('R',NULL)");for(let i=1;i<=300;i++)await S(`select gymos.invoice_allocation_refs_complete('S${i}',NULL)`);
await S('analyze gymos.gym_entities');await S('analyze gymos.invoice_allocation_refs');await S('analyze gymos.invoice_allocation_refs_state');
const counts=(await S("select count(*) n,count(distinct owner_id) o from gymos.gym_entities")).rows[0];
const cl=new pg.Client({host:'/tmp/pgdata',user:'postgres',database:'rehearsal_w'});await cl.connect();
await cl.query('SET ROLE gymos_app');
let txt='fixture: '+JSON.stringify(counts)+' (owner R: 3000 members/60000 payments/60000 invoices over 3 branches a,b,c; 300 owners S* with 100 invoices; V1 virgin no state row; V2 state row never completed). Runtime role gymos_app, FORCE RLS, driver-captured statements.\n\n';
const summary=[];
const run=async(label,owner,q)=>{
  await cl.query("SELECT set_config('app.gym_owner',$1,false)",[owner]);const log=[];
  const c={query:async(sql,v)=>{if(/owner_version|SELECT version FROM|to_regclass/.test(sql)&&!/gym_entities/.test(sql))return{rows:[{version:'1',ok:true}]};if(/set_config|current_setting/.test(sql))return cl.query(sql,v);log.push([sql,v]);return cl.query(sql,v);}};
  const t0=Date.now();const out=await readReportPaymentsRefs((o,w)=>w(c),{owner,...q});const ms=Date.now()-t0;
  txt+=`=== ${label}: owner ${owner} branch ${q.branch} branches ${JSON.stringify(q.branches??null)} range ${q.from}..${q.to}${q.after?' after '+JSON.stringify(q.after):''}\nresult: status ${out.status}${out.reason?' reason '+out.reason:''} rows ${out.rows?.length??'-'} next ${JSON.stringify(out.next??null)} total-ms ${ms}\n`;
  let seq=[];
  for(const [sql,v] of log){const r=await cl.query('EXPLAIN (ANALYZE,BUFFERS,COSTS OFF,TIMING OFF) '+sql,v);const lines=r.rows.map(x=>x['QUERY PLAN']);
    for(const l of lines)if(/Seq Scan on (gym_entities|invoice_allocation_refs)\b/.test(l)&&!/never executed/.test(l))seq.push(l.trim());
    txt+='-- bound '+JSON.stringify(v).slice(0,160)+'\n'+lines.join('\n')+'\n';}
  txt+='\n';summary.push({label,status:out.status,rows:out.rows?.length??null,ms,statements:log.length,bigSeqScans:seq});return out;};
const B=(q)=>({branch:'a',branches:null,from:'2026-03-01',to:'2026-03-31',...q});
await run('unrestricted (no branch list), active branch a (odd-day payments live in hidden branch c, do not block)','R',B({}));
const first=await run('restricted single branch b (first page; hidden-branch odd days do not block)','R',B({branch:'b',branches:['b']}));
await run('restricted two branches a,c','R',B({branch:'a',branches:['a','c']}));
await run('restricted single branch c (holds the odd-day payments: expected fail-closed refusal non-canonical-day)','R',B({branch:'c',branches:['c']}));
let cur=first.next,pages=1;while(cur&&pages<5){const o=await run('keyset page '+(pages+1),'R',B({branch:'b',branches:['b'],after:cur,ver:first.version}));cur=o.next;pages++;}
await run('far keyset page (cursor on 2026-03-30, 25 days into range; text day order under COLLATE C)','R',B({branch:'b',branches:['b'],after:{day:'2026-03-30',pos:100,id:'p100'},ver:first.version}));
await run('wide range (Jan-Jun) first page, branch b','R',B({branch:'b',branches:['b'],from:'2026-01-01',to:'2026-06-30'}));
await run('many-owner skew: small owner S150 among 300','S150',B({branch:'a',branches:null}));
await run('virgin owner V1 (no state row) fallback','V1',B({}));
await run('unready owner V2 (state row, not completed)','V2',B({}));
fs.writeFileSync('/downloads/refs-driver-plans-matrix.txt',txt);
console.log(JSON.stringify(summary,null,1));
await cl.query('RESET ROLE');await cl.end();
await S("delete from gymos.gym_entities where owner_id ~ '^(R|S[0-9]+|V[12])$'; delete from gymos.gym_states where user_id ~ '^(R|S[0-9]+|V[12])$'; delete from gymos.invoice_allocation_refs_state where owner_id ~ '^(R|S[0-9]+|V[12])$'");await sup.end();
