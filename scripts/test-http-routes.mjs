// ACTUAL-PATH backup route coverage: real `next dev` server, real HTTP requests, real PG,
// GoTrue stubbed locally (verification shape only: GET /auth/v1/user -> fixed users per token).
// Covers the v2 download GET (under/over-limit, recovery), v2 transfer download+upload+restore
// commit, and the v3 downloadStart, all through the production route handlers.
import {spawn} from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import {withScope} from '../app/lib/database.ts';
import {emptyState} from '../app/lib/domain.ts';

const AUTH_PORT=4911, DEV_PORT=3791;
const USERS={'test-access':'http-owner-under','test-access-over':'http-owner-over'};
let passed=0,failed=0;
const ok=(name,cond,extra)=>{if(cond){passed++;console.log('PASS',name);}else{failed++;console.log('FAIL',name,extra??'');}};

const stub=http.createServer((req,res)=>{
 const tok=(req.headers.authorization??'').replace('Bearer ','');
 if(req.url?.startsWith('/auth/v1/user')&&USERS[tok]){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:USERS[tok],email:'http@test.local',email_confirmed_at:'2026-01-01T00:00:00.000Z',user_metadata:{full_name:'HTTP Test',name:'HTTP Test'}}));}
 else{res.writeHead(401,{'Content-Type':'application/json'});res.end('{"message":"unauthorized"}');}
});
await new Promise(r=>stub.listen(AUTH_PORT,'127.0.0.1',r));

const admin=new pg.Client(process.env.DATABASE_URL_ADMIN||process.env.DATABASE_URL);await admin.connect();
const seed=async(owner,{photos=0,photoBytes=0,events=0}={})=>{
 await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,7,$3)',[owner,JSON.stringify({...emptyState(),_entityStorage:1}),new Date().toISOString()]));
 if(photos){await withScope(owner,c=>c.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'members','m'||g,g,'main',jsonb_build_object('id','m'||g,'name','Member '||g,'branch','main','phone','01000000000','joined','2026-01-01','expires','2027-01-01','demo',false,'archived',false,'consent',true) FROM generate_series(1,$2::int) g",[owner,photos]));await withScope(owner,c=>c.query("INSERT INTO gymos.gym_photos(owner_id,member_id,content) SELECT $1,'m'||g,'data:image/jpeg;base64,/9j/'||repeat('A',$3::int-27) FROM generate_series(1,$2::int) g",[owner,photos,photoBytes]));}
 if(events)await withScope(owner,c=>c.query("INSERT INTO gymos.gym_activity_archive(owner_id,event_id,branch,at,payload) SELECT $1,'ev-'||g,'main','2026-10-01T10:00:00.000Z',jsonb_build_object('id','ev-'||g,'at','2026-10-01T10:00:00.000Z','kind','seed','subject','s'||g,'actor','seed','branch','main') FROM generate_series(1,$2::int) g",[owner,events]));
};
const rid=crypto.randomUUID();
await seed(USERS['test-access'],{photos:80,photoBytes:96_000,events:1000});
await seed(USERS['test-access-over'],{photos:900,photoBytes:96_000});
await withScope(USERS['test-access'],c=>c.query('INSERT INTO gymos.gym_recovery(id,owner_id,payload,created_at) VALUES($1,$2,$3,$4)',[rid,USERS['test-access'],JSON.stringify({...emptyState(),members:[{id:'old-member',name:'Old Member',branch:'main'}]}),new Date().toISOString()]));
await withScope(USERS['test-access'],c=>c.query("INSERT INTO gymos.gym_recovery_photos(recovery_id,owner_id,member_id,content) VALUES($1,$2,'old-member',repeat('B',96000))",[rid,USERS['test-access']]));

const dev=spawn('npx',['next','dev','--webpack','-p',String(DEV_PORT),'-H','127.0.0.1'],{env:{...process.env,GYMOS_AUTH_BACKEND:'supabase',NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${AUTH_PORT}`,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'stub-key'},stdio:['ignore','pipe','pipe']});
dev.stderr.on('data',()=>{});
let devLog='';dev.stdout.on('data',d=>{devLog+=d;});
const cleanup=async()=>{try{dev.kill('SIGKILL');}catch{};await new Promise(r=>stub.close(r));await admin.end();process.exit(failed?1:0);};

const cookieFor=tok=>'gymos_session='+Buffer.from(JSON.stringify({a:tok,r:'r'})).toString('base64url');
const base=`http://127.0.0.1:${DEV_PORT}`;
const call=(path,{method='GET',tok='test-access',owner=USERS['test-access'],body}={})=>new Promise((resolve,reject)=>{
 // raw http.request: undici fetch strips the forbidden Origin header, which the route's sameOrigin check requires for POST
 const headers={'X-GymOS-Tenant':owner};
 if(tok)headers.Cookie=cookieFor(tok);
 if(body!==undefined){headers['Content-Type']='application/json';headers.Origin='http://localhost:'+DEV_PORT;} // Next dev normalizes request.url host to localhost
 const req=http.request({host:'127.0.0.1',port:DEV_PORT,path,method,headers},res=>{let buf='';res.on('data',d=>buf+=d);res.on('end',()=>{let json=null;try{json=JSON.parse(buf);}catch{}resolve({status:res.statusCode,json});});});
 req.on('error',reject);
 if(body!==undefined)req.write(JSON.stringify(body));
 req.end();
});

// readiness: poll until the route compiles and answers (401 unauth = up)
let up=false;
for(let i=0;i<120;i++){try{const r=await fetch(base+'/api/backup');if(r.status===401){up=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
if(!up){console.log('FAIL dev server never became ready');console.log(devLog.slice(-2000));failed++;await cleanup();}
console.log('dev server ready');

// 1-2: auth gate
ok('no cookie -> 401',(await call('/api/backup',{tok:null})).status===401);
ok('bad token -> 401',(await call('/api/backup',{tok:'bogus'})).status===401);

// 3: under-limit v2 GET actual body
const g=await call('/api/backup');
ok('under-limit v2 GET 200',g.status===200,JSON.stringify(g.json).slice(0,120));
ok('v2 body shape',g.json?.format==='gymos-backup'&&g.json?.version===2&&typeof g.json?.digest==='string');
ok('photos inline on members over HTTP',(g.json?.state?.members??[]).length===80&&(g.json.state.members??[]).every(m=>typeof m.photo==='string'&&m.photo.length===96000&&m.photo.startsWith('data:image/jpeg;base64,/9j/')));
ok('archive merged over HTTP',(g.json?.state?.events??[]).length===1000);
ok('revision carried over HTTP',g.json?.revision===7);

// 4: over-limit actual path
const go=await call('/api/backup',{tok:'test-access-over',owner:USERS['test-access-over']});
ok('over-limit v2 GET -> 413 limit over HTTP',go.status===413&&go.json?.error==='limit',JSON.stringify(go.json));

// 5: recovery export over HTTP
const gr=await call('/api/backup?recovery='+encodeURIComponent(rid));
ok('recovery GET 200 with photo reattached to its member',gr.status===200&&(gr.json?.state?.members??[])[0]?.id==='old-member'&&(gr.json?.state?.members??[])[0]?.photo?.length===96000,JSON.stringify(gr.json).slice(0,150));

// 6: v2 transfer download (downloadStart -> chunks -> digest)
const ds=await call('/api/backup',{method:'POST',body:{action:'downloadStart'}});
ok('v2 downloadStart 200 with parts',ds.status===200&&ds.json?.parts>=1&&typeof ds.json?.id==='string',JSON.stringify(ds.json));
let assembled=null;
if(ds.status===200){const parts=[];for(let i=0;i<ds.json.parts;i++){const c=await call(`/api/backup?transfer=${encodeURIComponent(ds.json.id)}&part=${i}`);if(c.status!==200)break;parts.push(Buffer.from(c.json.data,'base64'));}
 assembled=Buffer.concat(parts);
 ok('transfer chunks assemble to digest',crypto.createHash('sha256').update(assembled).digest('hex')===ds.json.digest);
 ok('transfer body is the v2 backup',JSON.parse(assembled.toString('utf8')).version===2);
 await call('/api/backup',{method:'POST',body:{action:'transferCancel',id:ds.json.id}});
}

// 7: over-limit downloadStart -> 413
const dso=await call('/api/backup',{method:'POST',tok:'test-access-over',owner:USERS['test-access-over'],body:{action:'downloadStart'}});
ok('over-limit downloadStart -> 413 limit',dso.status===413&&dso.json?.error==='limit',JSON.stringify(dso.json));

// 8: v3 downloadStart -> session + core section
const d3=await call('/api/backup',{method:'POST',body:{action:'downloadStart',format:3}});
ok('v3 downloadStart 200 with core section',d3.status===200&&d3.json?.format===3&&d3.json?.core?.id,d3.status+' '+JSON.stringify(d3.json).slice(0,150));
if(d3.status===200){const s0=await call(`/api/backup?section=${encodeURIComponent(d3.json.core.id)}&part=0`);ok('v3 core section chunk 200',s0.status===200&&typeof s0.json?.data==='string');await call('/api/backup',{method:'POST',body:{action:'uploadAbort',session:d3.json.session}});}

// 9: v2 restore round-trip over HTTP (write path): upload the downloaded body, commit
if(assembled){
 const digest=crypto.createHash('sha256').update(assembled).digest('hex');
 const up=await call('/api/backup',{method:'POST',body:{action:'uploadStart',bytes:assembled.length,digest}});
 ok('v2 uploadStart 200',up.status===200&&typeof up.json?.id==='string',JSON.stringify(up.json));
 if(up.status===200){
  for(let i=0;i<up.json.parts;i++){const chunk=assembled.subarray(i*up.json.chunkBytes,(i+1)*up.json.chunkBytes);const uc=await call('/api/backup',{method:'POST',body:{action:'uploadChunk',id:up.json.id,index:i,data:chunk.toString('base64')}});if(uc.status!==200){ok('uploadChunk '+i,false,JSON.stringify(uc.json));break;}}
  const commit=await call('/api/backup',{method:'POST',body:{action:'uploadCommit',id:up.json.id,confirm:'RESTORE',revision:7}});
  ok('v2 restore commit 200',commit.status===200,JSON.stringify(commit.json));
  const after=await call('/api/backup');
  ok('state intact after restore (photos+events)',after.status===200&&(after.json?.state?.members??[]).length===80&&(after.json?.state?.events??[]).length>=1001); // restore appends a backup.restore event
 }
}
console.log(failed?`FAILURES: ${failed}`:'ALL PASS',`(${passed} passed)`);
await cleanup();
