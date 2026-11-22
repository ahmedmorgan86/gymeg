// ACTUAL-PATH backup route coverage: real `next dev` server, real HTTP requests, real PG,
// GoTrue stubbed locally (verification shape only: GET /auth/v1/user -> fixed users per token).
// v2: GET under/over-limit, recovery reattach, transfer download + upload + restore round trip.
// v3: full download (core + downloadNext photo/event pages) with BYTE-EXACT photo verification
//     and per-section descriptor digest checks, plus a complete uploadSection -> uploadCommit restore.
// Gates: auth, cross-owner gymos-space without membership, non-admin role (default GET).
// HARD GUARD: refuses to run against anything but the disposable embedded harness DB.
//   Both DATABASE_URL and DATABASE_URL_ADMIN are parsed (scheme/host/port/database); the refusal
//   NEVER prints a supplied URL (it can carry credentials).
// Cleanup: a single top-level try/finally owns the GoTrue stub, the admin connection, the seeded
//   fixture rows, and the dev-server process GROUP; a whole-run deadline bounds total runtime and
//   every HTTP request carries its own timeout.
import {spawn} from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const harnessUrl=u=>{try{const x=new URL(u);return (x.protocol==='postgres:'||x.protocol==='postgresql:')&&(x.hostname==='localhost'||x.hostname==='127.0.0.1')&&x.port==='55436'&&x.pathname==='/gymtest';}catch{return false;}};
if(!harnessUrl(process.env.DATABASE_URL)||!harnessUrl(process.env.DATABASE_URL_ADMIN)){console.error('REFUSE: DATABASE_URL and DATABASE_URL_ADMIN must both parse as postgres://<localhost|127.0.0.1>:55436/gymtest (the disposable embedded harness). Supplied value(s) did not match and are not printed, to avoid leaking credentials.');process.exit(2);}

import {withScope} from '../app/lib/database.ts';
import {emptyState} from '../app/lib/domain.ts';

const AUTH_PORT=4911, DEV_PORT=3791, REQUEST_TIMEOUT_MS=20_000, RUN_DEADLINE_MS=150_000;
const USERS={'test-access':'http-owner-under','test-access-over':'http-owner-over','test-staff':'http-staff-1'};
const OWNERS=[USERS['test-access'],USERS['test-access-over']];
const PHOTO='data:image/jpeg;base64,/9j/'+'A'.repeat(96000-27);
let passed=0,failed=0;
const ok=(name,cond,extra)=>{if(cond){passed++;console.log('PASS',name);}else{failed++;console.log('FAIL',name,extra??'');}};
const sha256=u=>crypto.createHash('sha256').update(u).digest('hex');
const enc=s=>new TextEncoder().encode(s);

let stub=null,admin=null,dev=null;
const deadline=setTimeout(()=>{console.error('FAIL harness deadline exceeded ('+RUN_DEADLINE_MS+'ms)');try{if(dev?.pid)process.kill(-dev.pid,'SIGKILL');}catch{}try{if(dev)dev.kill('SIGKILL');}catch{}process.exit(3);},RUN_DEADLINE_MS);

try{
 stub=http.createServer((req,res)=>{
  const tok=(req.headers.authorization??'').replace('Bearer ','');
  if(req.url?.startsWith('/auth/v1/user')&&USERS[tok]){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:USERS[tok],email:'http@test.local',email_confirmed_at:'2026-01-01T00:00:00.000Z',user_metadata:{full_name:'HTTP Test',name:'HTTP Test'}}));}
  else{res.writeHead(401,{'Content-Type':'application/json'});res.end('{"message":"unauthorized"}');}
 });
 await new Promise(r=>stub.listen(AUTH_PORT,'127.0.0.1',r));

 admin=new pg.Client(process.env.DATABASE_URL_ADMIN);await admin.connect();
 const seed=async(owner,{photos=0,events=0}={})=>{
  await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,7,$3)',[owner,JSON.stringify({...emptyState(),_entityStorage:1}),new Date().toISOString()]));
  if(photos){await withScope(owner,c=>c.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'members','m'||g,g,'main',jsonb_build_object('id','m'||g,'name','Member '||g,'branch','main','phone','01000000000','joined','2026-01-01','expires','2027-01-01','demo',false,'archived',false,'consent',true) FROM generate_series(1,$2::int) g",[owner,photos]));await withScope(owner,c=>c.query("INSERT INTO gymos.gym_photos(owner_id,member_id,content) SELECT $1,'m'||g,$3 FROM generate_series(1,$2::int) g",[owner,photos,PHOTO]));}
  if(events)await withScope(owner,c=>c.query("INSERT INTO gymos.gym_activity_archive(owner_id,event_id,branch,at,payload) SELECT $1,'ev-'||g,'main','2026-10-01T10:00:00.000Z',jsonb_build_object('id','ev-'||g,'at','2026-10-01T10:00:00.000Z','kind','seed','subject','s'||g,'actor','seed','branch','main') FROM generate_series(1,$2::int) g",[owner,events]));
 };
 const rid=crypto.randomUUID();
 await seed(USERS['test-access'],{photos:80,events:1000});
 await seed(USERS['test-access-over'],{photos:900});
 await withScope(USERS['test-access'],c=>c.query('INSERT INTO gymos.gym_recovery(id,owner_id,payload,created_at) VALUES($1,$2,$3,$4)',[rid,USERS['test-access'],JSON.stringify({...emptyState(),members:[{id:'old-member',name:'Old Member',branch:'main'}]}),new Date().toISOString()]));
 await withScope(USERS['test-access'],c=>c.query("INSERT INTO gymos.gym_recovery_photos(recovery_id,owner_id,member_id,content) VALUES($1,$2,'old-member',$3)",[rid,USERS['test-access'],PHOTO]));
 await withScope(USERS['test-access'],c=>c.query("INSERT INTO gymos.gym_access(owner_id,user_id,name,role,branches,revoked) VALUES($1,$2,'Staff One','reception','[\"main\"]',0)",[USERS['test-access'],USERS['test-staff']]));

 // detached: the dev server gets its own process group so the finally can kill the whole tree
 dev=spawn('npx',['next','dev','--webpack','-p',String(DEV_PORT),'-H','127.0.0.1'],{detached:true,env:{...process.env,GYMOS_AUTH_BACKEND:'supabase',NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${AUTH_PORT}`,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'stub-key'},stdio:['ignore','pipe','pipe']});
 dev.stderr.on('data',()=>{});let devLog='';dev.stdout.on('data',d=>{devLog+=d;});

 const cookieFor=(tok,space)=>{let c='gymos_session='+Buffer.from(JSON.stringify({a:tok,r:'r'})).toString('base64url');if(space)c+='; gymos-space='+space;return c;};
 const base=`http://127.0.0.1:${DEV_PORT}`;
 const call=(path,{method='GET',tok='test-access',owner=USERS['test-access'],body,space}={})=>new Promise((resolve,reject)=>{
  // raw http.request: undici fetch strips the forbidden Origin header, which sameOrigin requires for POST
  const headers={'X-GymOS-Tenant':owner};
  if(tok)headers.Cookie=cookieFor(tok,space);
  if(body!==undefined){headers['Content-Type']='application/json';headers.Origin='http://localhost:'+DEV_PORT;} // Next dev normalizes request.url host to localhost
  const req=http.request({host:'127.0.0.1',port:DEV_PORT,path,method,headers},res=>{let buf='';res.on('data',d=>buf+=d);res.on('end',()=>{let json=null;try{json=JSON.parse(buf);}catch{}resolve({status:res.statusCode,json});});});
  req.setTimeout(REQUEST_TIMEOUT_MS,()=>req.destroy(new Error('request timeout '+REQUEST_TIMEOUT_MS+'ms')));
  req.on('error',reject);
  if(body!==undefined)req.write(JSON.stringify(body));
  req.end();
 });
 const fetchSectionParts=async ref=>{const parts=[];for(let i=0;i<ref.parts;i++){const r=await call(`/api/backup?section=${encodeURIComponent(ref.id)}&part=${i}`);if(r.status!==200)throw new Error('section part '+i+' -> '+r.status);parts.push(Buffer.from(r.json.data,'base64'));}return Buffer.concat(parts);};

 let up=false;
 for(let i=0;i<110;i++){try{const r=await fetch(base+'/api/backup');if(r.status===401){up=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
 if(!up){console.log('FAIL dev server never became ready');console.log(devLog.slice(-2000));failed++;throw new Error('dev server');}
 console.log('dev server ready');

 // --- auth gates
 ok('no cookie -> 401',(await call('/api/backup',{tok:null})).status===401);
 ok('bad token -> 401',(await call('/api/backup',{tok:'bogus'})).status===401);

 // --- cross-access + role gates
 const cross=await call('/api/backup',{space:USERS['test-access-over']});
 ok('cross-owner gymos-space without membership -> non-200, no data (fail-closed, not a specific status)',cross.status!==200&&!(cross.json?.state?.members?.length),cross.status+' '+JSON.stringify(cross.json).slice(0,100));
 const staff=await call('/api/backup',{tok:'test-staff',space:USERS['test-access']});
 ok('non-admin member (reception) -> 403 forbidden on default GET',staff.status===403&&staff.json?.error==='forbidden',staff.status+' '+JSON.stringify(staff.json));

 // --- v2 GET under-limit, byte-exact photos
 const g=await call('/api/backup');
 ok('under-limit v2 GET 200',g.status===200,JSON.stringify(g.json).slice(0,120));
 ok('v2 body shape',g.json?.format==='gymos-backup'&&g.json?.version===2&&typeof g.json?.digest==='string');
 ok('photos byte-exact inline on members over HTTP',(g.json?.state?.members??[]).length===80&&(g.json.state.members??[]).every(m=>m.photo===PHOTO));
 ok('archive merged over HTTP',(g.json?.state?.events??[]).length===1000);
 ok('revision carried over HTTP',g.json?.revision===7);

 // --- over-limit admission over HTTP
 const go=await call('/api/backup',{tok:'test-access-over',owner:USERS['test-access-over']});
 ok('over-limit v2 GET -> 413 limit over HTTP',go.status===413&&go.json?.error==='limit',JSON.stringify(go.json));

 // --- recovery GET
 const gr=await call('/api/backup?recovery='+encodeURIComponent(rid));
 ok('recovery GET 200, preserved photo byte-exact on its member',gr.status===200&&(gr.json?.state?.members??[])[0]?.id==='old-member'&&(gr.json?.state?.members??[])[0]?.photo===PHOTO,JSON.stringify(gr.json).slice(0,150));

 // --- v2 transfer download
 const ds=await call('/api/backup',{method:'POST',body:{action:'downloadStart'}});
 ok('v2 downloadStart 200 with parts',ds.status===200&&ds.json?.parts>=1&&typeof ds.json?.id==='string',JSON.stringify(ds.json));
 let assembled=null;
 if(ds.status===200){const parts=[];for(let i=0;i<ds.json.parts;i++){const c=await call(`/api/backup?transfer=${encodeURIComponent(ds.json.id)}&part=${i}`);parts.push(Buffer.from(c.json.data,'base64'));}
 assembled=Buffer.concat(parts);
 ok('transfer chunks assemble to digest',sha256(assembled)===ds.json.digest);
 ok('transfer body is the v2 backup',JSON.parse(assembled.toString('utf8')).version===2);
 await call('/api/backup',{method:'POST',body:{action:'transferCancel',id:ds.json.id}});
 }
 const dso=await call('/api/backup',{method:'POST',tok:'test-access-over',owner:USERS['test-access-over'],body:{action:'downloadStart'}});
 ok('over-limit downloadStart -> 413 limit',dso.status===413&&dso.json?.error==='limit',JSON.stringify(dso.json));

 // --- v3 FULL download: core section + downloadNext photo/event pages, byte-exact + digest-verified
 const d3=await call('/api/backup',{method:'POST',body:{action:'downloadStart',format:3}});
 ok('v3 downloadStart 200 with core section',d3.status===200&&d3.json?.format===3&&d3.json?.core?.id,d3.status);
 let v3photos={},v3events=[],v3core=null;
 if(d3.status===200){
  const sid=d3.json.session;
  const coreBuf=await fetchSectionParts(d3.json.core);
  ok('v3 core section matches descriptor digest',sha256(coreBuf)===d3.json.core.digest);
  v3core=JSON.parse(coreBuf.toString('utf8'));
  ok('v3 core parses, members photo-free',v3core&&(v3core.members??[]).length===80&&(v3core.members??[]).every(m=>m.photo===undefined));
  let digestsOk=true;
  for(let cursor=null,ordinal=(d3.json.photoSections??[]).length;;){const r=await call('/api/backup',{method:'POST',body:{action:'downloadNext',format:3,session:sid,kind:'photos',cursor,ordinal}});if(r.json?.done&&!r.json?.page)break;const buf=await fetchSectionParts(r.json.page);if(sha256(buf)!==r.json.page.digest)digestsOk=false;Object.assign(v3photos,JSON.parse(buf.toString('utf8')));cursor=r.json.nextCursor??null;ordinal++;if(r.json.done)break;}
  ok('v3 photo pages match descriptor digests',digestsOk);
  ok('v3 photo pages: 80 photos byte-exact',Object.keys(v3photos).length===80&&Object.values(v3photos).every(c=>c===PHOTO),Object.keys(v3photos).length);
  digestsOk=true;
  for(let cursor=null,ordinal=(d3.json.eventSections??[]).length;;){const r=await call('/api/backup',{method:'POST',body:{action:'downloadNext',format:3,session:sid,kind:'events',cursor,ordinal}});if(r.json?.done&&!r.json?.page)break;const buf=await fetchSectionParts(r.json.page);if(sha256(buf)!==r.json.page.digest)digestsOk=false;v3events.push(...JSON.parse(buf.toString('utf8')));cursor=r.json.nextCursor??null;ordinal++;if(r.json.done)break;}
  ok('v3 event pages match descriptor digests',digestsOk);
  ok('v3 event pages: 1000 events (count/kind assertions; byte identity covered by section digests)',v3events.length===1000&&v3events.every(e=>e.kind==='seed'),String(v3events.length));
 }

 // --- v2 restore round trip (write path)
 if(assembled){
  const digest=sha256(assembled);
  const up=await call('/api/backup',{method:'POST',body:{action:'uploadStart',bytes:assembled.length,digest}});
  ok('v2 uploadStart 200',up.status===200&&typeof up.json?.id==='string',JSON.stringify(up.json));
  if(up.status===200){
   for(let i=0;i<up.json.parts;i++){const chunk=assembled.subarray(i*up.json.chunkBytes,(i+1)*up.json.chunkBytes);await call('/api/backup',{method:'POST',body:{action:'uploadChunk',id:up.json.id,index:i,data:chunk.toString('base64')}});}
   const cur=await call('/api/backup');
   const commit=await call('/api/backup',{method:'POST',body:{action:'uploadCommit',id:up.json.id,confirm:'RESTORE',revision:cur.json.revision}});
   ok('v2 restore commit 200',commit.status===200,JSON.stringify(commit.json));
   const after=await call('/api/backup');
   ok('v2 restore: photos byte-exact after commit',after.status===200&&(after.json?.state?.members??[]).length===80&&(after.json.state.members??[]).every(m=>m.photo===PHOTO));
   ok('v2 restore: events preserved + restore event appended',(after.json?.state?.events??[]).length===1001);
  }
 }

 // --- v3 restore round trip: uploadSection core/photos/events + uploadCommit
 if(v3core){
  const us=await call('/api/backup',{method:'POST',body:{action:'uploadStart',format:3}});
  ok('v3 uploadStart 200 with session',us.status===200&&typeof us.json?.session==='string',JSON.stringify(us.json));
  if(us.status===200){
   const sid=us.json.session;
   const stage=async(kind,ordinal,buf)=>{const digest=sha256(buf);const sec=(await call('/api/backup',{method:'POST',body:{action:'uploadSection',session:sid,kind,ordinal,bytes:buf.length,digest}})).json;for(let i=0;i<sec.parts;i++){const part=buf.subarray(i*sec.chunkBytes,(i+1)*sec.chunkBytes);const r=await call('/api/backup',{method:'POST',body:{action:'uploadSectionChunk',section:sec.id,index:i,data:Buffer.from(part).toString('base64')}});if(r.status!==200)throw Error(`stage ${kind}[${ordinal}] chunk ${i} -> ${r.status} ${JSON.stringify(r.json)}`);}return{ordinal,bytes:buf.length,digest,transfer:sec.id};};
   const coreRef=await stage('core',0,enc(JSON.stringify(v3core)));
   const photoRefs=[];{let page={},size=2,ordinal=0;for(const id of Object.keys(v3photos).sort()){const cost=enc(id).length+enc(v3photos[id]).length+9;if(size+cost>2_000_000&&Object.keys(page).length){photoRefs.push(await stage('photos',ordinal++,enc(JSON.stringify(page))));page={};size=2;}page[id]=v3photos[id];size+=cost;}if(Object.keys(page).length)photoRefs.push(await stage('photos',ordinal,enc(JSON.stringify(page))));}
   const eventRefs=[];{let page=[],size=2,ordinal=0;for(const e of v3events){const cost=enc(JSON.stringify(e)).length+2;if(size+cost>8_000_000&&page.length){eventRefs.push(await stage('events',ordinal++,enc(JSON.stringify(page))));page=[];size=2;}page.push(e);size+=cost;}if(page.length)eventRefs.push(await stage('events',ordinal,enc(JSON.stringify(page))));}
   const manifest={format:'gymos-backup',version:3,tenant:USERS['test-access'],createdAt:new Date().toISOString(),revision:d3.json.revision,core:{bytes:coreRef.bytes,digest:coreRef.digest},photos:{count:Object.keys(v3photos).length,pages:photoRefs},events:{count:v3events.length,pages:eventRefs}};
   manifest.digest=sha256(enc(JSON.stringify(manifest)));
   const cur=await call('/api/backup');
   const commit=await call('/api/backup',{method:'POST',body:{action:'uploadCommit',format:3,session:sid,manifest,revision:cur.json.revision,confirm:'RESTORE'}});
   ok('v3 restore commit 200',commit.status===200,JSON.stringify(commit.json).slice(0,150));
   const after=await call('/api/backup');
   ok('v3 restore: photos byte-exact after commit',after.status===200&&(after.json?.state?.members??[]).length===80&&(after.json.state.members??[]).every(m=>m.photo===PHOTO));
   {const evs=after.json?.state?.events??[];const seeded=evs.filter(e=>e.kind==='seed').length;const restores=evs.filter(e=>e.kind==='backup.restore').length;ok('v3 restore: 1000 seeded events preserved + both restore events',evs.length===1002&&seeded===1000&&restores===2,`total=${evs.length} seeded=${seeded} restores=${restores}`);}
  }
 }
}catch(err){if(err.message!=='dev server'){failed++;console.log('FAIL harness error:',err.message);}}
finally{
 clearTimeout(deadline);
 if(dev){try{if(dev.pid)process.kill(-dev.pid,'SIGKILL');else dev.kill('SIGKILL');}catch{try{dev.kill('SIGKILL');}catch{}}await Promise.race([new Promise(r=>dev.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
 if(stub)try{await new Promise(r=>stub.close(r));}catch{}
 if(admin)try{
  // fixture cleanup: only the fixed harness owner IDs, bounded deletes
  for(const t of ['gym_backup_sections','gym_backup_sessions','gym_backup_transfers','gym_recovery_photos','gym_recovery','gym_access','gym_activity_archive','gym_photos','gym_entities']){
   await admin.query(`DELETE FROM gymos.${t} WHERE owner_id=ANY($1)`,[OWNERS]).catch(()=>{});
  }
  await admin.query('DELETE FROM gymos.gym_states WHERE user_id=ANY($1)',[OWNERS]).catch(()=>{});
  await admin.end();
 }catch{}
}
console.log(failed?`FAILURES: ${failed}`:'ALL PASS',`(${passed} passed)`);
process.exit(failed?1:0);
