"use client";
// LOCAL-ONLY verification harness: renders the real BackupPanel against a stubbed /api/backup
// with REAL chunked sections and REAL sha256 digests, so the production client lib runs end to
// end in the browser. Never committed to the shared branch.
import {useEffect,useState} from 'react';
import BackupPanel from '../backup-panel';
if(typeof window!=='undefined')(window as unknown as Record<string,unknown>).__preview_module=1;

const b64=(u:Uint8Array)=>{let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode(...u.subarray(i,i+8192));return btoa(s);};
const sha=async(u:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',u as Uint8Array<ArrayBuffer>))).map(x=>x.toString(16).padStart(2,'0')).join('');
const enc=(s:string)=>new TextEncoder().encode(s);

async function installFetchMock(scenario:string){
 if(scenario==='fallback'){delete (window as unknown as Record<string,unknown>).showSaveFilePicker;}
 const core=enc(JSON.stringify({members:[{id:'m1',name:'عضو تجريبي',branch:'main'},{id:'m2',name:'Member Two',branch:'main'}],events:[],branches:[{id:'main',name:'Main'}]}));
 const photos=enc(JSON.stringify({m1:'data:image/jpeg;base64,/9j/'+'A'.repeat(4000),m2:'data:image/jpeg;base64,/9j/'+'B'.repeat(5000)}));
 const events=enc(JSON.stringify([{id:'e1',at:'2026-01-01T00:00:00.000Z',kind:'member.save',subject:'عضو تجريبي',actor:'Test',branch:'main'}]));
 const sections:Record<string,Uint8Array>={'sec-core':core,'sec-photos':photos,'sec-events':events};
 const digests:Record<string,string>={};for(const [k,v]of Object.entries(sections))digests[k]=await sha(v);
 const ref=(id:string)=>({id,transfer:id,bytes:sections[id].length,digest:digests[id],parts:1,chunkBytes:8*1024*1024});
 const real=window.fetch.bind(window);
 window.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);
  if(url.startsWith('/api/backup?section=')){
   const p=new URLSearchParams(url.split('?')[1]);const body=sections[p.get('section')??'']??new Uint8Array();
   if(scenario==='slow')await new Promise(r=>setTimeout(r,900));
   return new Response(JSON.stringify({data:b64(body)}),{status:200,headers:{'Content-Type':'application/json'}});
  }
  if(url==='/api/backup'&&init?.method==='POST'){
   const body=JSON.parse(String(init.body));
   if(scenario==='slow')await new Promise(r=>setTimeout(r,700));
   if(body.action==='downloadStart'&&body.format===3&&scenario==='unsupported')return Response.json({error:'unsupportedBackend'},{status:400});
   if(body.action==='downloadStart'&&body.format===3)return Response.json({format:3,session:'dev-session',tenant:'dev-gym',revision:3,core:ref('sec-core'),photoSections:[ref('sec-photos')],photosStaged:2,photoCount:2,eventSections:[ref('sec-events')],eventsStaged:1,eventCount:1,estimate:{photoBytes:photos.length,eventBytes:events.length},photoPageBytes:2000000,eventPageBytes:8000000});
   if(body.action==='uploadStart'&&body.format===3)return Response.json({format:3,session:'dev-up',chunkBytes:8*1024*1024});
   if(body.action==='uploadSection')return Response.json({id:'up-'+body.kind+body.ordinal,parts:Math.ceil(body.bytes/(8*1024*1024))||1,chunkBytes:8*1024*1024});
   if(body.action==='uploadSectionChunk')return Response.json({ok:true});
   if(body.action==='uploadCommit')return scenario==='commitConflict'?Response.json({error:'conflict'},{status:409}):Response.json({ok:true});
   if(body.action==='uploadAbort')return Response.json({ok:true});
   if(scenario==='v2'||scenario==='unsupported'){ // simulate Firestore backend: v3 unsupported, v2 transfer flow
    if(body.action==='downloadStart')return Response.json({id:'v2t',bytes:core.length,parts:1,chunkBytes:8*1024*1024,digest:await sha(core)});
    if(body.action==='transferCancel')return Response.json({ok:true});
    if(body.action==='uploadStart')return Response.json({id:'v2u',parts:1,chunkBytes:8*1024*1024});
    if(body.action==='uploadChunk')return Response.json({ok:true});
    if(body.action==='uploadCommit')return Response.json({ok:true});
   }
   return Response.json({error:'invalid'},{status:400});
  }
  if(url.startsWith('/api/backup?transfer=')){const p=new URLSearchParams(url.split('?')[1]);void p;return Response.json({data:b64(core)});}
  return real(input,init);
 };
}

export default function Preview(){
 const [ready,setReady]=useState(false);
 useEffect(()=>{(window as unknown as Record<string,unknown>).__effect_ran=1;const scenario=new URLSearchParams(location.search).get('scenario')??'ok';void installFetchMock(scenario).then(()=>setReady(true));},[]);
 if(!ready)return <p dir="rtl">…</p>;
 return <main dir="rtl" lang="ar" style={{maxWidth:760,margin:'0 auto',padding:16,fontFamily:'sans-serif',background:'#0f141b',minHeight:'100vh',color:'#e8edf3'}}><BackupPanel owner="dev-gym" revision={3} ar={true} reload={async()=>{}}/></main>;
}
