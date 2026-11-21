// Evidence, not a test: synthetic scanned work for the stored-summary reader. Local PGlite, not capacity.
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},load(u,x,n){return n(u,x);}});
const {readMemberCandidates,refreshDirtySummaries}=await import('../app/lib/member-summary-store.ts');
const M=Number(process.argv[2]??2000),HEAVY=Number(process.argv[3]??20000);
await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('E','{\"_entityStorage\":1}',1,'x')");
await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'E','members','m'||g,g,'a',jsonb_build_object('id','m'||g,'branch','a','joined','2026-01-01','expires','2026-12-31') FROM generate_series(1,$1) g",[M]);
// 3 visits per ordinary member (distinct days, closed), HEAVY visits for m1 (skew), plus invoices/payments
await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'E','visits','v'||g||'_'||d,g*1000+d,'a',jsonb_build_object('id','v'||g||'_'||d,'member','m'||g,'branch','a','day','2026-03-0'||d,'at','2026-03-0'||d||'T10:00:00.000Z','leftAt','2026-03-0'||d||'T11:00:00.000Z') FROM generate_series(2,$1) g, generate_series(1,3) d",[M]);
await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'E','visits','h'||g,5000000+g,'a',jsonb_build_object('id','h'||g,'member','m1','branch','a','day','d'||g,'at','2025-01-01T10:00:00.000Z','leftAt','2025-01-01T11:00:00.000Z') FROM generate_series(1,$1) g",[HEAVY]);
await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'E','invoices','i'||g,g,'a',jsonb_build_object('id','i'||g,'member','m'||g,'branch','a','total',100,'voided',false,'allocations','[]'::jsonb) FROM generate_series(1,$1) g",[M]);
await db.query("ANALYZE gymos.gym_entities");
const log=[];
const run=async()=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','E',true)");return readMemberCandidates({query:async(s,v)=>{const r=await c.query(s,v);log.push({s:s.slice(0,70),rows:r.rows.length});return r;}},'E',null);});
await db.query("INSERT INTO gymos.gym_member_summary_ready(owner_id) VALUES('E') ON CONFLICT DO NOTHING");
await db.query("SELECT gymos.backfill_member_summaries('E')");
let t=performance.now();let r=await run();
for(let n=0;typeof r==='string'&&n<100;n++){const x=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','E',true)");return refreshDirtySummaries(c,'E');});if(x.remaining===0){r=await run();break;}}console.log('first read (all dirty):',{members:r.candidates?.length,refreshed:r.refreshed??r,ms:Math.round(performance.now()-t)});

const buf=async(label,sql,v)=>{const r=await db.query('EXPLAIN (ANALYZE,BUFFERS,COSTS OFF,TIMING OFF) '+sql,v);const txt=r.rows.map(x=>x['QUERY PLAN']).join('\n');const sh=[...txt.matchAll(/shared hit=(\d+)/g)].map(m=>+m[1]).reduce((a,b)=>a+b,0)+[...txt.matchAll(/read=(\d+)/g)].map(m=>+m[1]).reduce((a,b)=>a+b,0);console.log(label,'buffers~',sh,'|',txt.split('\n')[0].trim().slice(0,110));};
const visitsQ="SELECT payload FROM gymos.gym_entities WHERE owner_id='E' AND collection='visits' AND payload->>'member'=ANY($1::text[]) ORDER BY position,entity_id";
console.log('clean read queries:',JSON.stringify((log.length=0,await run(),log)));
await db.query("UPDATE gymos.gym_entities SET payload=payload WHERE owner_id='E' AND collection='invoices' AND entity_id='i2'");
log.length=0;t=performance.now();r=await run();console.log('one ordinary member dirty (payment/invoice change): refreshed',r.refreshed,Math.round(performance.now()-t),'ms',JSON.stringify(log.filter(x=>/visits|payments|invoices|INSERT|DELETE/.test(x.s)||x.rows>1).map(x=>x.rows)));
await db.query("UPDATE gymos.gym_entities SET payload=payload WHERE owner_id='E' AND collection='invoices' AND entity_id='i1'");
t=performance.now();r=await run();console.log('heavy member (m1, '+HEAVY+' visits) dirty: refreshed',r.refreshed,Math.round(performance.now()-t),'ms');
await buf('visits of one ordinary member',visitsQ,[['m2']]);
await buf('visits of the heavy member   ',visitsQ,[['m1']]);
await buf('ALL visits (the old full read)',"SELECT payload FROM gymos.gym_entities WHERE owner_id='E' AND collection='visits'",[]);
await buf('members of the owner (candidate read)',"SELECT entity_id,payload FROM gymos.gym_entities WHERE owner_id='E' AND collection='members' ORDER BY position,entity_id",[]);
