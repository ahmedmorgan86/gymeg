import {registerHooks,stripTypeScriptTypes} from 'node:module';import {readFileSync} from 'node:fs';
import {test,after,mock} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();let rowsRead=0;
globalThis.__postDb={query:async(s,v)=>{const r=await real.query(s,v);rowsRead+=r.rows?.length??0;return r;},transaction:fn=>real.transaction(c=>fn({query:async(s,v)=>{const r=await c.query(s,v);rowsRead+=r.rows?.length??0;return r;}}))};
after(()=>real.close());
registerHooks({load(url,c,n){if(url.endsWith('/app/lib/photo-decode.ts'))return{format:'module',shortCircuit:true,source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8').replace('return info.width===meta.width','if(globalThis.__reviewDecodeDelay)await new Promise(r=>setTimeout(r,globalThis.__reviewDecodeDelay));return info.width===meta.width'))};const loaded=n(url,c);if(url.endsWith('/app/lib/server-workspace.ts')&&typeof loaded.source==='string')loaded.source=loaded.source.replace("export const hash=async text=>createHash('sha256').update(text).digest('hex');","export const hash=async text=>{await globalThis.__reviewHashHook?.();return createHash('sha256').update(text).digest('hex');};");return loaded;}});
const {POST}=await import('../app/api/workspace/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {club,NOW}=await import('./hot-ops-fixture.mjs');
const {applyOperation}=await import('../app/lib/domain.ts');
const {normalize}=await import('../app/lib/extensions.ts');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
function ctx(owner,extra={}){globalThis.__qaContext={owner,tenantId:'t-'+owner,role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'},...extra};}
async function seed(owner){
  const s=club(1);const seen=new Set();for(const v of s.visits){if(v.leftAt)continue;if(seen.has(v.member))v.leftAt=v.at.slice(0,11)+'23:00:00.000Z';else seen.add(v.member);}
  const {metadata,entities}=splitState(s);
  await real.query('DELETE FROM gymos.gym_entities WHERE owner_id=$1',[owner]);await real.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[owner]);await real.query('DELETE FROM gymos.gym_activity_archive WHERE owner_id=$1',[owner]);await real.query('DELETE FROM gymos.workspace_events WHERE owner_id=$1',[owner]);
  await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  return s;
}
const post=(owner,body,delta=true)=>POST(new Request('https://example.test/api/workspace',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json','X-GymOS-Tenant':'t-'+owner,...(delta?{'X-GymOS-Sync-Mode':'delta'}:{})},body:JSON.stringify(body)}));
const rev=async o=>(await real.query('SELECT revision FROM gymos.gym_states WHERE user_id=$1',[o])).rows[0].revision;
async function seedSmall(owner,grants){
  const {emptyState}=await import('../app/lib/domain.ts');
  const st=emptyState();st.branches=[{id:'a',name:'A'},{id:'b',name:'B'}];st.settings.timezone='Africa/Cairo';if(grants)st.settings.receptionGrants=grants;
  st.members=['m1','m2'].map(id=>({id,name:'Member '+id,phone:'0100000000'+id.slice(1),branch:'a',joined:'2026-01-01',expires:'2026-12-31',archived:false,demo:false}));
  const {metadata,entities}=splitState(st);
  for(const t of ['gym_entities','gym_states'])await real.query(`DELETE FROM gymos.${t} WHERE ${t==='gym_states'?'user_id':'owner_id'}=$1`,[owner]);
  await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
import sharp from 'sharp';
const webp=async(w=320)=>'data:image/webp;base64,'+(await sharp({create:{width:w,height:w,channels:3,background:'#468'}}).webp({quality:80}).toBuffer()).toString('base64');
const fake=()=>{const b=Buffer.alloc(30);b.write('RIFF',0);b.writeUInt32LE(22,4);b.write('WEBPVP8 ',8);b.writeUInt32LE(10,16);return 'data:image/webp;base64,'+b.toString('base64');};
let n=0;const rid=()=>'req-photo-admission-'+(++n)+'-xxxxxxxx';
const photoOf=async(o,id)=>(await real.query('SELECT content FROM gymos.gym_photos WHERE owner_id=$1 AND member_id=$2',[o,id])).rows[0]?.content;

test('REAL route + PGlite: flag ON admits a real WebP, rejects a fabricated one, never touches non-photo text; flag OFF rejects WebP',async()=>{
  const owner='photo-adm';await seedSmall(owner);ctx(owner);
  try{
    process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
    const good=await webp();let r0=await rev(owner);
    let res=await post(owner,{revision:r0,requestId:rid(),operation:{type:'member.photo',branch:'a',id:'m1',photo:good}});
    assert.equal(res.status,200);assert.equal(await photoOf(owner,'m1'),good,'real WebP stored byte-exact');
    const r1=await rev(owner);assert.ok(r1>r0);
    res=await post(owner,{revision:r1,requestId:rid(),operation:{type:'member.photo',branch:'a',id:'m2',photo:fake()}});
    assert.equal(res.status,400);assert.equal((await res.json()).error,'invalid');assert.equal(await rev(owner),r1,'rejected before any write');assert.equal(await photoOf(owner,'m2'),undefined);
    // Text that merely starts with the same prefix is not a photo slot: an ordinary member name is not decoded or rejected.
    res=await post(owner,{revision:r1,requestId:rid(),operation:{type:'member.save',branch:'a',name:'data:image/webp club',phone:'01000000009',joined:'2026-10-01',expires:'2026-12-01'}});
    assert.equal(res.status,200,'non-photo text with the webp prefix is accepted exactly as before');
    // Junk in an ignored field costs nothing and is not a photo slot.
    const r2=await rev(owner);
    res=await post(owner,{revision:r2,requestId:rid(),operation:{type:'member.save',branch:'a',name:'Junk Field',phone:'01000000010',joined:'2026-10-01',expires:'2026-12-01',junk:Array.from({length:1000},()=>fake())}});
    assert.notEqual((await res.json()).error,'invalid-photo');assert.ok([200,400].includes(res.status));
    // Flag OFF: WebP never admitted.
    delete process.env.NEXT_PUBLIC_PHOTO_WEBP;
    const r3=await rev(owner);
    res=await post(owner,{revision:r3,requestId:rid(),operation:{type:'member.photo',branch:'a',id:'m2',photo:good}});
    assert.ok(res.status>=400&&res.status<500);assert.equal(await photoOf(owner,'m2'),undefined);
  }finally{delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});

test('REAL route: EVERY photo-bearing operation type is decoded (member.details and member.register included), owner and reception-with-grant',async()=>{
  const b=Buffer.alloc(30);b.write('RIFF',0);b.writeUInt32LE(22,4);b.write('WEBPVP8 ',8);b.writeUInt32LE(10,16);b.set([0x9d,1,0x2a],23);b.writeUInt16LE(64,26);b.writeUInt16LE(64,28);
  const invalid='data:image/webp;base64,'+b.toString('base64'),good=await webp();
  const fields=(photo)=>({branch:'a',name:'Synthetic New Member',phone:'01000000000',extraPhone:'',address:'',notes:'',subscriptionNotes:'',gender:'unspecified',photo});
  const ops=(photo,tag)=>[{...fields(photo),type:'member.details',id:'m1'},{...fields(photo),type:'member.register',memberId:'new-member-id-'+tag+'0123456789',joined:'2026-01-01',code:'GYM'+tag},{type:'member.save',branch:'a',name:'Saved '+tag,phone:'0100000'+tag.padStart(4,'0'),joined:'2026-10-01',expires:'2026-12-01',photo},{type:'member.photo',branch:'a',id:'m2',photo}];
  try{
    process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
    for(const [role,grants] of [['owner',undefined],['reception',{staff:['member.register','member.details']}]]){
      const owner='photo-ops-'+role;await seedSmall(owner,grants);ctx(owner,{role});
      const only=(o)=>role==='owner'||['member.register','member.details'].includes(o.type); // reception may be granted these two
      for(const operation of ops(invalid,'1').filter(only)){
        const before=await rev(owner),res=await post(owner,{revision:before,requestId:rid(),operation});
        assert.equal(res.status,400,role+' '+operation.type+' with an undecodable WebP is rejected');assert.equal(await rev(owner),before,'no write');
        assert.equal(await photoOf(owner,operation.id??operation.memberId),undefined);
      }
      let k=2;
      for(const operation of ops(good,'7').filter(only)){
        const res=await post(owner,{revision:await rev(owner),requestId:rid(),operation:{...operation,...(operation.memberId?{memberId:'new-member-id-'+(++k)+'0123456789',code:'GYM'+k}:{}),...(operation.type==='member.save'||operation.type==='member.register'?{phone:'0100009'+String(k+(operation.type==='member.save'?50:0)).padStart(4,'0')}:{})}});
        assert.equal(res.status,200,role+' '+operation.type+' with a real WebP is stored: '+res.status);
      }
      assert.equal(await photoOf(owner,'m1'),good);if(role==='owner')assert.equal(await photoOf(owner,'m2'),good);
    }
  }finally{delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});


test('a decode that finishes AFTER the work deadline is 503 busy and writes nothing',async()=>{
 const {decodeLimits}=await import('../app/lib/photo-admission.ts');const old=decodeLimits.workMs;const owner='late-decode';await seedSmall(owner);ctx(owner);process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
 try{const good=await webp();decodeLimits.workMs=5;globalThis.__reviewDecodeDelay=30;const start=Date.now();const res=await post(owner,{revision:await rev(owner),requestId:rid(),operation:{type:'member.photo',branch:'a',id:'m1',photo:good}});console.log('REVIEWER deadline',res.status,'elapsed',Date.now()-start);assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:'busy'});assert.equal(await photoOf(owner,'m1'),undefined);
 }finally{decodeLimits.workMs=old;globalThis.__reviewDecodeDelay=0;delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});

test('an aborted queued HTTP photo request leaves the queue, is 503 busy and writes nothing',async()=>{
 const {withDecodeGate,decodeGateStats}=await import('../app/lib/photo-admission.ts');const owner='aborted-queued';await seedSmall(owner);ctx(owner);process.env.NEXT_PUBLIC_PHOTO_WEBP='1';let release;const held=new Promise(r=>release=r);const running=withDecodeGate(()=>held);
 try{const ctrl=new AbortController();const request=new Request('https://example.test/api/workspace',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json','X-GymOS-Tenant':'t-'+owner,'X-GymOS-Sync-Mode':'delta'},signal:ctrl.signal,body:JSON.stringify({revision:await rev(owner),requestId:rid(),operation:{type:'member.photo',branch:'a',id:'m1',photo:await webp()}})});const pending=POST(request);
 const started=Date.now();while(decodeGateStats().waiting===0&&Date.now()-started<1000)await new Promise(r=>setTimeout(r,1));assert.equal(decodeGateStats().waiting,1);ctrl.abort();release();await running;const res=await pending;console.log('REVIEWER aborted request',res.status,'signal',request.signal.aborted);assert.equal(res.status,503);assert.equal(await photoOf(owner,'m1'),undefined);assert.equal(decodeGateStats().waiting,0);
 }finally{release();await running;delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});

test('HTTP busy responses on queue full and wait expiry are503 with no revision change',async()=>{
 const {withDecodeGate,decodeLimits}=await import('../app/lib/photo-admission.ts');const owner='http-busy';await seedSmall(owner);ctx(owner);process.env.NEXT_PUBLIC_PHOTO_WEBP='1';const old={...decodeLimits};let release;const running=withDecodeGate(()=>new Promise(r=>release=r));
 try{const good=await webp(),before=await rev(owner);const body=()=>({revision:before,requestId:rid(),operation:{type:'member.photo',branch:'a',id:'m1',photo:good}});
 decodeLimits.maxWaiting=0;let res=await post(owner,body());assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:'busy'});assert.equal(await rev(owner),before);
 decodeLimits.maxWaiting=1;decodeLimits.waitMs=10;res=await post(owner,body());assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:'busy'});assert.equal(await rev(owner),before);assert.equal(await photoOf(owner,'m1'),undefined);
 }finally{release();await running;Object.assign(decodeLimits,old);delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});

test('zero-WebP fast path: a JPEG-only photo op and a name edit never enter the gate, so a full/held gate cannot make them 503',async()=>{
 const {withDecodeGate,decodeLimits,decodeGateStats}=await import('../app/lib/photo-admission.ts');const owner='fastpath';await seedSmall(owner);ctx(owner);process.env.NEXT_PUBLIC_PHOTO_WEBP='1';const old={...decodeLimits};let release;const running=withDecodeGate(()=>new Promise(r=>release=r));
 try{decodeLimits.maxWaiting=0;const jpeg='data:image/jpeg;base64,'+(await sharp({create:{width:64,height:64,channels:3,background:'#468'}}).jpeg().toBuffer()).toString('base64');
 const res=await post(owner,{revision:await rev(owner),requestId:rid(),operation:{type:'member.photo',branch:'a',id:'m1',photo:jpeg}});assert.equal(res.status,200,'JPEG-only op is not blocked by a held gate');assert.equal(await photoOf(owner,'m1'),jpeg);assert.equal(decodeGateStats().waiting,0);
 const webpRes=await post(owner,{revision:await rev(owner),requestId:rid(),operation:{type:'member.photo',branch:'a',id:'m1',photo:await webp()}});assert.equal(webpRes.status,503,'a WebP op still needs the gate');
 }finally{release();await running;Object.assign(decodeLimits,old);delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});


test('abort after a successful decode, while hashing, is 503 busy and writes nothing',async()=>{
 const owner='abort-after-decode';await seedSmall(owner);ctx(owner);process.env.NEXT_PUBLIC_PHOTO_WEBP='1';const ac=new AbortController();let calls=0;
 try{globalThis.__reviewHashHook=()=>{if(++calls===2)ac.abort();};const good=await webp();const request=new Request('https://example.test/api/workspace',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json','X-GymOS-Tenant':'t-'+owner,'X-GymOS-Sync-Mode':'delta'},signal:ac.signal,body:JSON.stringify({revision:await rev(owner),requestId:rid(),operation:{type:'member.photo',branch:'a',id:'m1',photo:good}})});const res=await POST(request);console.log('post-gate workspace abort',calls,ac.signal.aborted,res.status);assert.equal(calls,2);assert.equal(ac.signal.aborted,true);assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:'busy'});assert.equal(await photoOf(owner,'m1'),undefined);
 }finally{delete globalThis.__reviewHashHook;delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});
