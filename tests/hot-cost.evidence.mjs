// Evidence script (not in the runner): scanned work (EXPLAIN ANALYZE shared buffers, all SELECTs of one POST) for the full read
// versus the hot path, at several club sizes, through the real POST handler on PGlite with the real migrations. Synthetic data only.
import {mock} from 'node:test';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();
let stat={sel:0,buffers:0,rows:0};
const measure=async(run,sql,v)=>{
  if(/^\s*(WITH|SELECT)/i.test(sql)&&!/set_config/.test(sql)){try{const e=await run(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,v);const p=(e.rows[0]['QUERY PLAN']??Object.values(e.rows[0])[0]);const plan=(typeof p==='string'?JSON.parse(p):p)[0].Plan;const b=(plan['Shared Hit Blocks']??0)+(plan['Shared Read Blocks']??0);stat.buffers+=b;stat.sel++;(stat.q??=[]).push([b,plan['Node Type'],sql.replace(/\s+/g,' ').slice(0,110)]);}catch{}}
  const r=await run(sql,v);stat.rows+=r.rows?.length??0;return r;
};
globalThis.__postDb={query:(s,v)=>measure((a,b)=>real.query(a,b),s,v),transaction:fn=>real.transaction(c=>fn({query:(s,v)=>measure((a,b)=>c.query(a,b),s,v)}))};
const {POST}=await import('../app/api/workspace/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');const {emptyState}=await import('../app/lib/domain.ts');const {NOW}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
async function seed(owner,members,visitsPer,paymentsPer){
  const st=emptyState();st.branches=[{id:'a',name:'A'},{id:'b',name:'B'}];st.settings.timezone='Africa/Cairo';
  st.members=Array.from({length:members},(_,i)=>({id:'m'+i,name:'Member '+i,phone:'010'+String(i).padStart(8,'0'),branch:i%2?'a':'b',joined:'2026-01-01',expires:'2026-12-31',archived:false,demo:false}));
  let n=0;for(const m of st.members)for(let k=0;k<visitsPer;k++){const d='2026-02-'+String(1+k%27).padStart(2,'0');st.visits.push({id:'v'+n++,member:m.id,branch:m.branch,day:d,at:d+'T10:00:00.000Z',leftAt:d+'T11:00:00.000Z'});}
  for(const m of st.members)for(let k=0;k<paymentsPer;k++)st.payments.push({id:'p'+n++,member:m.id,branch:m.branch,minor:100,day:'2026-02-01',method:'cash',at:'2026-02-01T10:00:00.000Z'});
  const {metadata,entities}=splitState(st);
  for(const t of ['gym_entities','gym_states'])await real.query(`DELETE FROM gymos.${t} WHERE ${t==='gym_states'?'user_id':'owner_id'}=$1`,[owner]);
  await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  for(let i=0;i<entities.length;i+=4000)await real.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,x.collection,x.entity_id,x.position,x.branch,x.payload FROM jsonb_to_recordset($2::jsonb) AS x(collection text,entity_id text,position integer,branch text,payload jsonb)",[owner,JSON.stringify(entities.slice(i,i+4000))]);
  await real.query('ANALYZE gymos.gym_entities');
  return entities.length;
}
const post=(owner,body)=>POST(new Request('https://example.test/api/workspace',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json','X-GymOS-Tenant':'t-'+owner,'X-GymOS-Sync-Mode':'delta'},body:JSON.stringify(body)}));
mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
const out=[];let lastQ=[];
for(const [members,vp,pp] of [[50,5,2],[500,10,3],[3000,10,3]]){
  const rows=await seed('X',members,vp,pp);
  for(const [name,flag,op] of [['full',false,{type:'payment.add',branch:'a',id:'m1',minor:250,method:'cash'}],['hot',true,{type:'payment.add',branch:'a',id:'m3',minor:250,method:'cash'}]]){
    await seed('X',members,vp,pp);
    if(flag)process.env.GYMOS_HOT_OPS='1';else delete process.env.GYMOS_HOT_OPS;
    globalThis.__qaContext={owner:'X',tenantId:'t-X',role:'owner',branches:null,license,user:{userId:'staff',displayName:'t'}};
    stat={sel:0,buffers:0,rows:0};const t=Date.now();
    const r=await post('X',{operation:op,requestId:'req-dddddddddddddddd1',revision:5});const j=await r.json();
    out.push({members,entityRows:rows,path:name,status:r.status,ok:j.ok===true,selects:stat.sel,sharedBuffers:stat.buffers,rowsReturned:stat.rows});
    if(flag)lastQ=stat.q??[];delete process.env.GYMOS_HOT_OPS;
  }
}
mock.timers.reset();
console.table(out);console.log('LAST HOT RUN PER QUERY (buffers, top node, sql):');for(const q of lastQ.sort((a,b)=>b[0]-a[0]).slice(0,10))console.log(q.join(' | '));await real.close();process.exit(0);
