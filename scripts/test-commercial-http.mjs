// COMMERCIAL / LICENSE GATE coverage: real `next dev` server (GYMOS_COMMERCIAL=1), real HTTP,
// real PG, GoTrue stubbed locally (verification shape only).
// Fixtures: four tenants with distinct license states (writable monthly, expired monthly,
// NO license row, closed trial) plus a platform-admin support session on the writable tenant.
// Gates: assertRequestTenant (clubChanged 409 on absent/mismatched mutation header, mismatched
// GET header), licenseReadOnly 403 (expired license, missing license row), read-only GET allowed
// under an expired license, upload blocked under it, trialExpired 403 (closed trial workspace),
// support session read-only (mutation 403 supportReadOnly, GET allowed), wrong support token 403.
// HARD GUARD: refuses to run against anything but the disposable embedded harness DB.
//   Both DATABASE_URL and DATABASE_URL_ADMIN are parsed; the refusal NEVER prints a supplied URL.
import {spawn} from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const harnessUrl=u=>{try{const x=new URL(u);return (x.protocol==='postgres:'||x.protocol==='postgresql:')&&(x.hostname==='localhost'||x.hostname==='127.0.0.1')&&x.port==='55436'&&x.pathname==='/gymtest';}catch{return false;}};
if(!harnessUrl(process.env.DATABASE_URL)||!harnessUrl(process.env.DATABASE_URL_ADMIN)){console.error('REFUSE: DATABASE_URL and DATABASE_URL_ADMIN must both parse as postgres://<localhost|127.0.0.1>:55436/gymtest (the disposable embedded harness). Supplied value(s) did not match and are not printed, to avoid leaking credentials.');process.exit(2);}

import {emptyState} from '../app/lib/domain.ts';

const AUTH_PORT=4911, DEV_PORT=3791, REQUEST_TIMEOUT_MS=20_000, RUN_DEADLINE_MS=150_000;
const USERS={'c-owner':'comm-owner-1','c-expired':'comm-expired-1','c-nolic':'comm-nolic-1','c-trial':'comm-trial-1','c-support':'comm-support-1'};
const TA='ta',TB='tb',TC='tc',TD='td'; // tenant ids; storage keys gym<letter>
const SUPPORT_TOKEN='ab'.repeat(32); // 64 hex chars
let passed=0,failed=0;
const ok=(name,cond,extra)=>{if(cond){passed++;console.log('PASS',name);}else{failed++;console.log('FAIL',name,extra??'');}};

let stub=null,admin=null,dev=null;
const deadline=setTimeout(()=>{console.error('FAIL harness deadline exceeded ('+RUN_DEADLINE_MS+'ms)');try{if(dev?.pid)process.kill(-dev.pid,'SIGKILL');}catch{}try{if(dev)dev.kill('SIGKILL');}catch{}process.exit(3);},RUN_DEADLINE_MS);

try{
 stub=http.createServer((req,res)=>{
  const tok=(req.headers.authorization??'').replace('Bearer ','');
  if(req.url?.startsWith('/auth/v1/user')&&USERS[tok]){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:USERS[tok],email:'comm@test.local',email_confirmed_at:'2026-01-01T00:00:00.000Z',user_metadata:{full_name:'Comm Test',name:'Comm Test'}}));}
  else{res.writeHead(401,{'Content-Type':'application/json'});res.end('{"message":"unauthorized"}');}
 });
 await new Promise(r=>stub.listen(AUTH_PORT,'127.0.0.1',r));

 admin=new pg.Client(process.env.DATABASE_URL_ADMIN);await admin.connect();
 const q=(text,params)=>admin.query(text,params);
 // tenants + memberships + licenses (superuser: bypasses RLS intentionally for seeding)
 const tenant=async(id,key,name)=>{await q('INSERT INTO gymos.tenants(id,storage_key,name,created_by) VALUES($1,$2,$3,$4)',[id,key,name,'fixture']);await q('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,7,$3)',[key,JSON.stringify({...emptyState(),_entityStorage:1}),new Date().toISOString()]);};
 const member=(tenant_id,user_id)=>q('INSERT INTO gymos.tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenant_id,user_id,'owner']);
 const license=(tenant_id,mode,ends)=>q("INSERT INTO gymos.tenant_licenses(tenant_id,plan_id,mode,status,starts_at,ends_at,limits) VALUES($1,'custom',$2,'active','2026-01-01T00:00:00Z',$3,'{\"branches\":5,\"members\":1000,\"staff\":20}')",[tenant_id,mode,ends]);
 await tenant(TA,'gyma','Writable Club');await member(TA,USERS['c-owner']);await license(TA,'monthly','2027-01-01T00:00:00Z');
 await tenant(TB,'gymb','Expired Club');await member(TB,USERS['c-expired']);await license(TB,'monthly','2026-06-01T00:00:00Z'); // ends_at past -> expired
 await tenant(TC,'gymc','No-License Club');await member(TC,USERS['c-nolic']); // no license row at all
 await tenant(TD,'gymd','Closed-Trial Club');await member(TD,USERS['c-trial']);await license(TD,'trial','2026-10-01T00:00:00Z'); // trial ends_at past -> closed
 // platform admin + live support session on the writable tenant
 await q('INSERT INTO gymos.platform_admins(user_id) VALUES($1)',[USERS['c-support']]);
 await q("INSERT INTO gymos.commercial_audit(id,actor,tenant_id,action,details) VALUES('sup-1',$1,$2,'support.started',$3)",[USERS['c-support'],TA,JSON.stringify({tokenHash:crypto.createHash('sha256').update(SUPPORT_TOKEN).digest('hex'),expiresAt:'2027-06-01T00:00:00.000Z',reason:'fixture session'})]);

 // detached: the dev server gets its own process group so the finally can kill the whole tree
 dev=spawn('npx',['next','dev','--webpack','-p',String(DEV_PORT),'-H','127.0.0.1'],{detached:true,env:{...process.env,GYMOS_COMMERCIAL:'1',GYMOS_AUTH_BACKEND:'supabase',NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${AUTH_PORT}`,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'stub-key'},stdio:['ignore','pipe','pipe']});
 dev.stderr.on('data',()=>{});let devLog='';dev.stdout.on('data',d=>{devLog+=d;});

 const base=`http://127.0.0.1:${DEV_PORT}`;
 // hdr: tenant header value; absent tenant => NO X-GymOS-Tenant header at all
 const call=(path,{method='GET',tok='c-owner',tenant,space,support,body}={})=>new Promise((resolve,reject)=>{
  const headers={};
  if(tenant!==undefined)headers['X-GymOS-Tenant']=tenant;
  if(tok){let c='gymos_session='+Buffer.from(JSON.stringify({a:tok,r:'r'})).toString('base64url');if(space)c+='; gymos-space='+space;if(support)c+='; gymos-support='+support;headers.Cookie=c;}
  if(body!==undefined){headers['Content-Type']='application/json';headers.Origin='http://localhost:'+DEV_PORT;}
  const req=http.request({host:'127.0.0.1',port:DEV_PORT,path,method,headers},res=>{let buf='';res.on('data',d=>buf+=d);res.on('end',()=>{let json=null;try{json=JSON.parse(buf);}catch{}resolve({status:res.statusCode,json});});});
  req.setTimeout(REQUEST_TIMEOUT_MS,()=>req.destroy(new Error('request timeout '+REQUEST_TIMEOUT_MS+'ms')));
  req.on('error',reject);
  if(body!==undefined)req.write(JSON.stringify(body));
  req.end();
 });

 let up=false;
 for(let i=0;i<110;i++){try{const r=await fetch(base+'/api/backup');if(r.status===401){up=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
 if(!up){console.log('FAIL dev server never became ready');console.log(devLog.slice(-2000));failed++;throw new Error('dev server');}
 console.log('dev server ready (GYMOS_COMMERCIAL=1)');

 // --- tenant header gates (assertRequestTenant)
 let r=await call('/api/workspace',{method:'POST',body:[]});
 ok('mutation with NO X-GymOS-Tenant header -> 409 clubChanged',r.status===409&&r.json?.error==='clubChanged',r.status+' '+JSON.stringify(r.json));
 r=await call('/api/workspace',{method:'POST',tenant:'bogus',body:[]});
 ok('mutation with mismatched tenant header -> 409 clubChanged',r.status===409&&r.json?.error==='clubChanged',r.status+' '+JSON.stringify(r.json));
 r=await call('/api/workspace',{method:'POST',tenant:TA,space:TA,body:{revision:7,requestId:crypto.randomUUID(),operation:{type:'settings.save',branch:'main',name:'Writable Club',currency:'EGP'}}});
 ok('mutation with correct tenant header + writable license -> 200',r.status===200,r.status+' '+JSON.stringify(r.json));
 r=await call('/api/workspace',{tenant:TA,space:TA});
 ok('GET with correct tenant header -> 200',r.status===200,r.status);
 r=await call('/api/workspace',{tenant:'bogus',space:TA});
 ok('GET with mismatched tenant header -> 409 clubChanged',r.status===409&&r.json?.error==='clubChanged',r.status+' '+JSON.stringify(r.json));
 r=await call('/api/workspace'); // no header: single membership auto-selects
 ok('GET without tenant header (single membership) -> 200',r.status===200,r.status);

 // --- license gates
 r=await call('/api/workspace',{method:'POST',tok:'c-expired',tenant:TB,space:TB,body:[]});
 ok('expired license mutation -> 403 licenseReadOnly',r.status===403&&r.json?.error==='licenseReadOnly',r.status+' '+JSON.stringify(r.json));
 r=await call('/api/backup',{tok:'c-expired',tenant:TB,space:TB});
 ok('expired license backup GET (read-only) -> 200',r.status===200,r.status+' '+JSON.stringify(r.json).slice(0,120));
 r=await call('/api/backup',{method:'POST',tok:'c-expired',tenant:TB,space:TB,body:{action:'upload-begin',version:3,manifest:{}}});
 ok('expired license backup upload -> 403 licenseReadOnly',r.status===403&&r.json?.error==='licenseReadOnly',r.status+' '+JSON.stringify(r.json));
 r=await call('/api/workspace',{method:'POST',tok:'c-nolic',tenant:TC,space:TC,body:[]});
 ok('tenant with NO license row mutation -> 403 licenseReadOnly (fail-closed)',r.status===403&&r.json?.error==='licenseReadOnly',r.status+' '+JSON.stringify(r.json));
 r=await call('/api/workspace',{tok:'c-trial',tenant:TD,space:TD});
 ok('closed trial workspace GET -> 403 trialExpired',r.status===403&&r.json?.error==='trialExpired',r.status+' '+JSON.stringify(r.json));

 // --- support session (platform admin, read-only)
 r=await call('/api/workspace',{method:'POST',tok:'c-support',tenant:TA,space:TA,support:SUPPORT_TOKEN,body:[]});
 ok('support session mutation -> 403 supportReadOnly',r.status===403&&r.json?.error==='supportReadOnly',r.status+' '+JSON.stringify(r.json));
 r=await call('/api/workspace',{tok:'c-support',tenant:TA,space:TA,support:SUPPORT_TOKEN});
 ok('support session GET -> 200 (read-only access works)',r.status===200,r.status+' '+JSON.stringify(r.json).slice(0,120));
 r=await call('/api/workspace',{tok:'c-support',tenant:TA,space:TA,support:'00'.repeat(32)});
 ok('wrong support token -> 403 supportExpired',r.status===403&&r.json?.error==='supportExpired',r.status+' '+JSON.stringify(r.json));

 // --- state isolation: writable mutation actually persisted under the tenant storage key
 const rev=(await call('/api/workspace',{tenant:TA,space:TA})).json?.revision;
 r=await call('/api/workspace',{method:'POST',tenant:TA,space:TA,body:{revision:rev,requestId:crypto.randomUUID(),operation:{type:'settings.save',branch:'main',name:'Isolation Check',currency:'USD'}}});
 const stored=await q("SELECT payload::jsonb->'settings'->>'currency' AS c, payload::jsonb->'settings'->>'name' AS n FROM gymos.gym_states WHERE user_id=$1",['gyma']);
 ok('commercial mutation persists under tenant storage_key (not user id)',r.status===200&&stored.rows[0]?.c==='USD'&&stored.rows[0]?.n==='Isolation Check',r.status+' '+JSON.stringify(stored.rows[0]??null).slice(0,160));
}catch(e){console.log('FAIL harness exception',e);failed++;}
finally{
 clearTimeout(deadline);
 try{if(dev?.pid)process.kill(-dev.pid,'SIGKILL');}catch{}
 try{if(dev)dev.kill('SIGKILL');}catch{}
 try{stub?.close();}catch{}
 if(admin){
  try{await admin.query("DELETE FROM gymos.commercial_audit WHERE id='sup-1'");}catch{}
  try{await admin.query('DELETE FROM gymos.platform_admins WHERE user_id=$1',[USERS['c-support']]);}catch{}
  try{await admin.query('DELETE FROM gymos.tenant_licenses WHERE tenant_id IN ($1,$2,$3,$4)',[TA,TB,TC,TD]);}catch{}
  try{await admin.query('DELETE FROM gymos.tenant_memberships WHERE tenant_id IN ($1,$2,$3,$4)',[TA,TB,TC,TD]);}catch{}
  try{await admin.query('DELETE FROM gymos.tenants WHERE id IN ($1,$2,$3,$4)',[TA,TB,TC,TD]);}catch{}
  try{await admin.query('DELETE FROM gymos.gym_states WHERE user_id IN ($1,$2,$3,$4)',['gyma','gymb','gymc','gymd']);}catch{}
  try{await admin.end();}catch{}
 }
 await new Promise(r=>setTimeout(r,500));
 console.log(`COMMERCIAL: ${failed===0?'ALL PASS':failed+' FAILED'} (${passed} passed)`);
 process.exit(failed===0?0:1);
}
