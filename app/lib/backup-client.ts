const MAX=64*1024*1024;
const digest=async(b:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b as Uint8Array<ArrayBuffer>))).map(x=>x.toString(16).padStart(2,'0')).join('');
async function request(owner:string,body:Record<string,unknown>){const r=await fetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json','X-GymOS-Tenant':owner},body:JSON.stringify(body),signal:AbortSignal.timeout(body.action==='uploadCommit'?240000:120000)});const d=await r.json();if(!r.ok)throw Error(d.error??'backup');return d;}
export async function downloadBackupText(owner:string,recovery?:string){const m=await request(owner,{action:'downloadStart',recovery});try{const bytes=new Uint8Array(m.bytes);if(m.bytes>MAX||m.bytes<1)throw Error('limit');for(let i=0;i<m.parts;i++){const r=await fetch(`/api/backup?transfer=${encodeURIComponent(m.id)}&part=${i}`,{cache:'no-store',headers:{'X-GymOS-Tenant':owner},signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('backup');const d=await r.json();const part=Uint8Array.from(atob(d.data),c=>c.charCodeAt(0));if(part.length!==Math.min(m.chunkBytes,m.bytes-i*m.chunkBytes))throw Error('invalidChunk');bytes.set(part,i*m.chunkBytes);}if(await digest(bytes)!==m.digest)throw Error('digestMismatch');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}finally{await request(owner,{action:'transferCancel',id:m.id}).catch(()=>{});}}
export async function restoreBackup(owner:string,backup:unknown,revision:number){const bytes=new TextEncoder().encode(JSON.stringify(backup));if(bytes.length>MAX)throw Error('limit');const m=await request(owner,{action:'uploadStart',bytes:bytes.length,digest:await digest(bytes)});try{for(let i=0;i<m.parts;i++){const part=bytes.subarray(i*m.chunkBytes,(i+1)*m.chunkBytes);let binary='';for(let j=0;j<part.length;j+=8192)binary+=String.fromCharCode(...part.subarray(j,j+8192));await request(owner,{action:'uploadChunk',id:m.id,index:i,data:btoa(binary)});}await request(owner,{action:'uploadCommit',id:m.id,revision,confirm:'RESTORE'});}finally{await request(owner,{action:'transferCancel',id:m.id}).catch(()=>{});}}

// ---- Backup format v3 client (postgres backend): bounded streaming download + sectioned restore ----
const V3_PHOTO_PAGE=2_000_000,V3_EVENT_PAGE=8_000_000,V3_FALLBACK_CAP=192*1024*1024,V3_RESTORE_CAP=256*1024*1024;
type V3Section={ordinal:number;bytes:number;digest:string;transfer:string;parts:number;chunkBytes:number};
type V3Writer={write:(s:string|Uint8Array)=>Promise<void>;finish:()=>Promise<Blob|null>};
export const v3Streams=()=>typeof window!=='undefined'&&window.isSecureContext&&'showSaveFilePicker' in window;
async function v3Writer(name:string):Promise<V3Writer>{
 if(v3Streams()){const handle=await (window as unknown as {showSaveFilePicker:(o:object)=>Promise<{createWritable:()=>Promise<{write:(d:string|Uint8Array)=>Promise<void>;close:()=>Promise<void>}>}>}).showSaveFilePicker({suggestedName:name,types:[{description:'GymEG backup',accept:{'application/json':['.json']}}]});const stream=await handle.createWritable();return{write:d=>stream.write(d),finish:async()=>{await stream.close();return null;}};}
 const parts:Uint8Array[]=[];const enc=new TextEncoder();
 return{write:async d=>{parts.push(typeof d==='string'?enc.encode(d):d);},finish:async()=>new Blob(parts as BlobPart[],{type:'application/json'})};
}
async function fetchSection(owner:string,sec0:V3Section,w:V3Writer,transform?:(text:string)=>string){
 const sec={...sec0,transfer:sec0.transfer??(sec0 as unknown as {id:string}).id}; // route returns id; manifests use transfer
 const bytes=new Uint8Array(sec.bytes);let off=0;
 for(let i=0;i<sec.parts;i++){const r=await fetch(`/api/backup?section=${encodeURIComponent(sec.transfer)}&part=${i}`,{cache:'no-store',headers:{'X-GymOS-Tenant':owner},signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('backup');const d=await r.json();const part=Uint8Array.from(atob(d.data),c=>c.charCodeAt(0));if(part.length!==Math.min(sec.chunkBytes,sec.bytes-i*sec.chunkBytes))throw Error('invalidChunk');bytes.set(part,off);off+=part.length;}
 if(await digest(bytes)!==sec.digest)throw Error('digestMismatch');
 await w.write(transform?transform(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):bytes);
}
export async function downloadBackupV3(owner:string,recovery:string|undefined,onProgress:(done:number,total:number)=>void):Promise<Blob|null>{
 const start=await request(owner,{action:'downloadStart',format:3,recovery});start.tenant=owner;
 const total=start.core.bytes+start.estimate.photoBytes+start.estimate.eventBytes;
 if(!v3Streams()&&total>V3_FALLBACK_CAP)throw Error('backupTooLargeForBrowser');
 const w=await v3Writer('GymEG-backup-'+new Date().toISOString().slice(0,10)+'.json');
 let done=0;const tick=(n:number)=>{done+=n;onProgress(done,total);};
 try{
  await w.write('{"format":"gymos-backup","version":3,"tenant":'+JSON.stringify(start.tenant??'')+',"createdAt":'+JSON.stringify(new Date().toISOString())+',"revision":'+start.revision+',"core":');
  await fetchSection(owner,start.core,w);tick(start.core.bytes);
  await w.write(',"photos":{');let first=true;
  const strip=(s:string)=>s.slice(1,-1);
  const putSection=async(sec:V3Section)=>{if(!first)await w.write(',');first=false;await fetchSection(owner,sec,w,strip);tick(sec.bytes);};
  for(const sec of start.photoSections??[])await putSection(sec);
  if(start.photosStaged<start.photoCount){let cursor:string|null=null,ordinal=(start.photoSections??[]).length;for(;;){const r=await request(owner,{action:'downloadNext',format:3,session:start.session,kind:'photos',cursor,ordinal});if(r.done&&!r.page)break;await putSection(r.page);cursor=r.nextCursor??null;ordinal++;if(r.done)break;}}
  await w.write('},"events":[');first=true;
  for(const sec of start.eventSections??[])await putSection(sec);
  if((start.eventsStaged??0)<start.eventCount){let cursor:null|{at:string;id:string}=null,ordinal=(start.eventSections??[]).length;for(;;){const r=await request(owner,{action:'downloadNext',format:3,session:start.session,kind:'events',cursor,ordinal});if(r.done&&!r.page)break;await putSection(r.page);cursor=r.nextCursor??null;ordinal++;if(r.done)break;}}
  await w.write(']}');
  return await w.finish();
 }finally{await request(owner,{action:'uploadAbort',session:start.session}).catch(()=>{});}
}
export async function restoreBackupV3(owner:string,file:unknown,revision:number,onProgress:(done:number,total:number)=>void){
 const b=file as {format?:string;version?:number;tenant?:string;createdAt?:string;revision?:number;core?:unknown;photos?:Record<string,string>;events?:unknown[]};
 if(b.format!=='gymos-backup'||b.version!==3||!b.core||typeof b.core!=='object'||!b.photos||typeof b.photos!=='object'||!Array.isArray(b.events))throw Error('invalidBackup');
 const enc=new TextEncoder();
 const coreBytes=enc.encode(JSON.stringify(b.core));
 const photoPages:Record<string,string>[]=[];{let page:Record<string,string>={},size=2;for(const [id,content]of Object.entries(b.photos).sort((a,z)=>a[0]<z[0]?-1:1)){const cost=enc.encode(id).length+enc.encode(content).length+9;if(size+cost>V3_PHOTO_PAGE&&Object.keys(page).length){photoPages.push(page);page={};size=2;}page[id]=content;size+=cost;}if(Object.keys(page).length)photoPages.push(page);}
 const eventPages:unknown[][]=[];{let page:unknown[]=[],size=2;for(const e of b.events){const cost=enc.encode(JSON.stringify(e)).length+2;if(size+cost>V3_EVENT_PAGE&&page.length){eventPages.push(page);page=[];size=2;}page.push(e);size+=cost;}if(page.length)eventPages.push(page);}
 const session=(await request(owner,{action:'uploadStart',format:3})).session;
 const total=coreBytes.length+photoPages.reduce((a,p)=>a+enc.encode(JSON.stringify(p)).length,0)+eventPages.reduce((a,p)=>a+enc.encode(JSON.stringify(p)).length,0);
 let done=0;
 const stage=async(kind:string,ordinal:number,bytes:Uint8Array):Promise<V3Section>=>{
  const d=await digest(bytes);
  const sec=await request(owner,{action:'uploadSection',session,kind,ordinal,bytes:bytes.length,digest:d});
  for(let i=0;i<sec.parts;i++){const part=bytes.subarray(i*sec.chunkBytes,(i+1)*sec.chunkBytes);let bin='';for(let j=0;j<part.length;j+=8192)bin+=String.fromCharCode(...part.subarray(j,j+8192));await request(owner,{action:'uploadSectionChunk',section:sec.id??sec.transfer,index:i,data:btoa(bin)});}
  done+=bytes.length;onProgress(done,total);
  return{ordinal,bytes:bytes.length,digest:d,transfer:sec.id??sec.transfer,parts:sec.parts,chunkBytes:sec.chunkBytes};
 };
 try{
  const coreRef=await stage('core',0,coreBytes);
  const photoRefs=[];for(let i=0;i<photoPages.length;i++)photoRefs.push(await stage('photos',i,enc.encode(JSON.stringify(photoPages[i]))));
  const eventRefs=[];for(let i=0;i<eventPages.length;i++)eventRefs.push(await stage('events',i,enc.encode(JSON.stringify(eventPages[i]))));
  const manifest:Record<string,unknown>={format:'gymos-backup',version:3,tenant:b.tenant,createdAt:b.createdAt??new Date().toISOString(),revision:b.revision,core:{bytes:coreRef.bytes,digest:coreRef.digest},photos:{count:Object.keys(b.photos).length,pages:photoRefs.map(({ordinal,bytes:by,digest:dg,transfer})=>({ordinal,bytes:by,digest:dg,transfer}))},events:{count:b.events.length,pages:eventRefs.map(({ordinal,bytes:by,digest:dg,transfer})=>({ordinal,bytes:by,digest:dg,transfer}))}};
  manifest.digest=await digest(enc.encode(JSON.stringify(manifest)));
  await request(owner,{action:'uploadCommit',format:3,session,manifest,revision,confirm:'RESTORE'});
 }finally{await request(owner,{action:'uploadAbort',session}).catch(()=>{});}
}
