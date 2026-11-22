const MAX=64*1024*1024;
const digest=async(b:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b as Uint8Array<ArrayBuffer>))).map(x=>x.toString(16).padStart(2,'0')).join('');
async function request(owner:string,body:Record<string,unknown>){const r=await fetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json','X-GymOS-Tenant':owner},body:JSON.stringify(body),signal:AbortSignal.timeout(body.action==='uploadCommit'?240000:120000)});const d=await r.json();if(!r.ok)throw Error(d.error??'backup');return d;}
export async function downloadBackupText(owner:string,recovery?:string){const m=await request(owner,{action:'downloadStart',recovery});try{if(!validTransfer(m,MAX))throw Error('limit');const bytes=new Uint8Array(m.bytes);for(let i=0;i<m.parts;i++){const r=await fetch(`/api/backup?transfer=${encodeURIComponent(m.id)}&part=${i}`,{cache:'no-store',headers:{'X-GymOS-Tenant':owner},signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('backup');const d=await r.json();const part=checkedPart(d.data,Math.min(m.chunkBytes,m.bytes-i*m.chunkBytes));bytes.set(part,i*m.chunkBytes);}if(await digest(bytes)!==m.digest)throw Error('digestMismatch');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}finally{await request(owner,{action:'transferCancel',id:m.id}).catch(()=>{});}}
export async function restoreBackup(owner:string,backup:unknown,revision:number){const text=JSON.stringify(backup);if(text.length>MAX)throw Error('limit'); /* utf8 bytes >= string length: this rejects before the encode allocates */ const bytes=new TextEncoder().encode(text);if(bytes.length>MAX)throw Error('limit');const m=await request(owner,{action:'uploadStart',bytes:bytes.length,digest:await digest(bytes)});try{for(let i=0;i<m.parts;i++){const part=bytes.subarray(i*m.chunkBytes,(i+1)*m.chunkBytes);let binary='';for(let j=0;j<part.length;j+=8192)binary+=String.fromCharCode(...part.subarray(j,j+8192));await request(owner,{action:'uploadChunk',id:m.id,index:i,data:btoa(binary)});}await request(owner,{action:'uploadCommit',id:m.id,revision,confirm:'RESTORE'});}finally{await request(owner,{action:'transferCancel',id:m.id}).catch(()=>{});}}

// ---- Backup format v3 client (postgres backend): bounded streaming download + sectioned restore ----
const V3_PHOTO_PAGE=2_000_000,V3_EVENT_PAGE=8_000_000,V3_FALLBACK_CAP=192*1024*1024,V3_RESTORE_CAP=256*1024*1024;
const V3_SECTION_MAX=22_000_000; // largest legit section: core (STATE_BYTE_LIMIT 20M + 1M slack) dominates the 2M/8M page bounds; a server claiming more is invalid
// Admission BEFORE allocation: every claimed byte count is validated as a bounded integer consistent with
// its chunking BEFORE any Uint8Array/atob work, so a bogus transfer descriptor cannot drive a huge alloc.
const validTransfer=(m:{bytes:unknown;chunkBytes:unknown;parts:unknown},cap:number)=>Number.isInteger(m.bytes)&&(m.bytes as number)>=1&&(m.bytes as number)<=cap&&Number.isInteger(m.chunkBytes)&&(m.chunkBytes as number)>=1&&(m.chunkBytes as number)<=cap&&m.parts===Math.ceil((m.bytes as number)/(m.chunkBytes as number));
const checkedPart=(data:unknown,expect:number):Uint8Array=>{if(typeof data!=='string'||data.length>Math.ceil(expect/3)*4)throw Error('invalidChunk');const part=Uint8Array.from(atob(data),c=>c.charCodeAt(0));if(part.length!==expect)throw Error('invalidChunk');return part;};
type V3Section={ordinal:number;bytes:number;digest:string;transfer:string;parts:number;chunkBytes:number};
type V3Writer={write:(s:string|Uint8Array)=>Promise<void>;finish:()=>Promise<Blob|null>;abort?:()=>Promise<void>};
export const v3Streams=()=>typeof window!=='undefined'&&window.isSecureContext&&'showSaveFilePicker' in window;
type SaveStream={write:(d:string|Uint8Array)=>Promise<void>;close:()=>Promise<void>;abort:()=>Promise<void>};
type SaveHandle={createWritable:()=>Promise<SaveStream>};
async function pickHandle(name:string):Promise<SaveHandle>{ // picker must run inside the click's transient activation: no awaits may precede it. Picking creates no writable here; whether the native picker itself pre-creates an empty file is browser behaviour we do not control.
 return (window as unknown as {showSaveFilePicker:(o:object)=>Promise<SaveHandle>}).showSaveFilePicker({suggestedName:name,types:[{description:'GymEG backup',accept:{'application/json':['.json']}}]});
}
async function streamWriter(handle:SaveHandle):Promise<V3Writer>{
 const stream=await handle.createWritable();
 return{write:d=>stream.write(d),finish:async()=>{await stream.close();return null;},abort:async()=>{await stream.abort();}}; // best-effort abort: asks the browser to discard the partial file
}
function collectWriter():V3Writer{ // fallback: accumulate with an ACTUAL byte cap; the estimate only preflights, this enforces
 const parts:Uint8Array[]=[];let total=0;const enc=new TextEncoder();
 return{write:async d=>{const b=typeof d==='string'?enc.encode(d):d;total+=b.length;if(total>V3_FALLBACK_CAP)throw Error('backupTooLargeForBrowser');parts.push(b);},finish:async()=>new Blob(parts as BlobPart[],{type:'application/json'})};
}
async function fetchSection(owner:string,sec0:V3Section,w:V3Writer,transform?:(text:string)=>string){
 const sec={...sec0,transfer:sec0.transfer??(sec0 as unknown as {id:string}).id}; // route returns id; manifests use transfer
 if(!validTransfer(sec,V3_SECTION_MAX))throw Error('invalidChunk');
 const bytes=new Uint8Array(sec.bytes);let off=0;
 for(let i=0;i<sec.parts;i++){const r=await fetch(`/api/backup?section=${encodeURIComponent(sec.transfer)}&part=${i}`,{cache:'no-store',headers:{'X-GymOS-Tenant':owner},signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('backup');const d=await r.json();const part=checkedPart(d.data,Math.min(sec.chunkBytes,sec.bytes-i*sec.chunkBytes));bytes.set(part,off);off+=part.length;}
 if(await digest(bytes)!==sec.digest)throw Error('digestMismatch');
 await w.write(transform?transform(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):bytes);
}
export async function downloadBackupV3(owner:string,recovery:string|undefined,onProgress:(done:number,total:number)=>void):Promise<Blob|null>{
 // Chooser BEFORE any network await: transient activation expires across the downloadStart round-trip, and a picker AbortError then leaves no server session behind at all.
 let handle:SaveHandle|null=null;
 if(v3Streams()){try{handle=await pickHandle('GymEG-backup-'+new Date().toISOString().slice(0,10)+'.json');}catch(e){throw e instanceof Error&&e.name==='AbortError'?Error('cancelled'):e;}}
 const start=await request(owner,{action:'downloadStart',format:3,recovery});start.tenant=owner; // throws (unsupportedBackend/auth/network) BEFORE any writable exists: nothing created, nothing to clean
 const total=start.core.bytes+start.estimate.photoBytes+start.estimate.eventBytes;
 let done=0;const tick=(n:number)=>{done+=n;onProgress(done,total);};
 let w:V3Writer|undefined,ok=false;
 try{ // every failure past this point - including the size preflight - discards the session
  if(!handle&&total>V3_FALLBACK_CAP)throw Error('backupTooLargeForBrowser');
  w=handle?await streamWriter(handle):collectWriter();const wr=w;
  await wr.write('{"format":"gymos-backup","version":3,"tenant":'+JSON.stringify(start.tenant??'')+',"createdAt":'+JSON.stringify(new Date().toISOString())+',"revision":'+start.revision+',"core":');
  await fetchSection(owner,start.core,wr);tick(start.core.bytes);
  await wr.write(',"photos":{');let first=true;
  const strip=(s:string)=>s.slice(1,-1);
  const putSection=async(sec:V3Section)=>{if(!first)await wr.write(',');first=false;await fetchSection(owner,sec,wr,strip);tick(sec.bytes);};
  for(const sec of start.photoSections??[])await putSection(sec);
  if(start.photosStaged<start.photoCount){let cursor:string|null=null,ordinal=(start.photoSections??[]).length;for(;;){const r=await request(owner,{action:'downloadNext',format:3,session:start.session,kind:'photos',cursor,ordinal});if(r.done&&!r.page)break;await putSection(r.page);cursor=r.nextCursor??null;ordinal++;if(r.done)break;}}
  await wr.write('},"events":[');first=true;
  for(const sec of start.eventSections??[])await putSection(sec);
  if((start.eventsStaged??0)<start.eventCount){let cursor:null|{at:string;id:string}=null,ordinal=(start.eventSections??[]).length;for(;;){const r=await request(owner,{action:'downloadNext',format:3,session:start.session,kind:'events',cursor,ordinal});if(r.done&&!r.page)break;await putSection(r.page);cursor=r.nextCursor??null;ordinal++;if(r.done)break;}}
  await wr.write(']}');
  const blob=await wr.finish();ok=true;
  return blob;
 }finally{if(!ok&&w?.abort)await w.abort().catch(()=>{});await request(owner,{action:'uploadAbort',session:start.session}).catch(()=>{});} // best-effort: an unfinished download aborts the writable and the server session
}
export async function restoreBackupV3(owner:string,file:File,revision:number,onProgress:(done:number,total:number)=>void){
 if(file.size>V3_RESTORE_CAP)throw Error('tooLarge'); // admission BEFORE parse: the parsed DOM and every staging buffer derive from this bound
 const b=JSON.parse(await file.text()) as {format?:string;version?:number;tenant?:string;createdAt?:string;revision?:number;core?:unknown;photos?:Record<string,string>;events?:unknown[]};
 if(b.format!=='gymos-backup'||b.version!==3||!b.core||typeof b.core!=='object'||!b.photos||typeof b.photos!=='object'||!Array.isArray(b.events))throw Error('invalidBackup');
 const enc=new TextEncoder();
 const session=(await request(owner,{action:'uploadStart',format:3})).session;
 const total=file.size;let done=0;
 const stage=async(kind:string,ordinal:number,bytes:Uint8Array):Promise<{ordinal:number;bytes:number;digest:string;transfer:string}>=>{
  const d=await digest(bytes);
  const sec=await request(owner,{action:'uploadSection',session,kind,ordinal,bytes:bytes.length,digest:d});
  for(let i=0;i<sec.parts;i++){const part=bytes.subarray(i*sec.chunkBytes,(i+1)*sec.chunkBytes);let bin='';for(let j=0;j<part.length;j+=8192)bin+=String.fromCharCode(...part.subarray(j,j+8192));await request(owner,{action:'uploadSectionChunk',section:sec.id,index:i,data:btoa(bin)});}
  done+=bytes.length;onProgress(done,total);
  return{ordinal,bytes:bytes.length,digest:d,transfer:sec.id};
 };
 try{
  const coreRef=await stage('core',0,enc.encode(JSON.stringify(b.core)));
  const photoRefs:{ordinal:number;bytes:number;digest:string;transfer:string}[]=[];
  {let page:Record<string,string>=Object.create(null),size=2,ordinal=0;for(const [id,content]of Object.entries(b.photos).sort((a,z)=>a[0]<z[0]?-1:1)){const cost=enc.encode(id).length+enc.encode(content).length+9;if(size+cost>V3_PHOTO_PAGE&&Object.keys(page).length){photoRefs.push(await stage('photos',ordinal++,enc.encode(JSON.stringify(page))));page=Object.create(null);size=2;}page[id]=content;size+=cost;}if(Object.keys(page).length)photoRefs.push(await stage('photos',ordinal,enc.encode(JSON.stringify(page))));} // one serialized page live at a time
  const eventRefs:{ordinal:number;bytes:number;digest:string;transfer:string}[]=[];
  {let page:unknown[]=[],size=2,ordinal=0;for(const e of b.events){const cost=enc.encode(JSON.stringify(e)).length+2;if(cost>V3_EVENT_PAGE)throw Error('invalidBackup');if(size+cost>V3_EVENT_PAGE&&page.length){eventRefs.push(await stage('events',ordinal++,enc.encode(JSON.stringify(page))));page=[];size=2;}page.push(e);size+=cost;}if(page.length)eventRefs.push(await stage('events',ordinal,enc.encode(JSON.stringify(page))));} // a single over-cap event fails before packing
  const manifest:Record<string,unknown>={format:'gymos-backup',version:3,tenant:b.tenant,createdAt:b.createdAt??new Date().toISOString(),revision:b.revision,core:{bytes:coreRef.bytes,digest:coreRef.digest},photos:{count:Object.keys(b.photos).length,pages:photoRefs},events:{count:b.events.length,pages:eventRefs}};
  manifest.digest=await digest(enc.encode(JSON.stringify(manifest)));
  await request(owner,{action:'uploadCommit',format:3,session,manifest,revision,confirm:'RESTORE'});
 }finally{await request(owner,{action:'uploadAbort',session}).catch(()=>{});}
}
