// Optional real-browser check (not in the runner: needs /tmp/harness with esbuild + puppeteer-core, and Chrome).
// Run: node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/member-console.browser.mjs
// STRICT variant: renders the REAL MemberConsole with NEXT_PUBLIC_GYMOS_LAZY_STRICT=1 and summaries ON, packet visits EMPTY (as a strict packet omission would deliver). Original header: Renders the REAL MemberConsole twice (flags OFF = legacy, ON = candidates + detail + paged history) against the REAL routes over PGlite and compares what the user sees.
import {createRequire} from 'node:module';import http from 'node:http';
const req=createRequire('/tmp/harness/');const esbuild=req('esbuild'),puppeteer=req('puppeteer-core');
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;
process.env.GYMOS_MEMBER_HISTORY='1';process.env.GYMOS_MEMBER_SUMMARIES='1';
const cand=await import('../app/api/workspace/member-candidates/route.ts'),det=await import('../app/api/workspace/member-detail/route.ts'),hist=await import('../app/api/workspace/member-history/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
const role=process.env.ROLE??'owner';
globalThis.__qaContext={owner:'A',tenantId:'t-A',role,branches:null,license,user:{userId:'staff',displayName:'tester'}};
const s=club(1);const big=s.members[0];for(let i=0;i<40;i++){const day='2026-02-'+String(1+(i%27)).padStart(2,'0');s.visits.push({id:'pg'+i,member:big.id,branch:big.branch,day,at:day+'T0'+(i%9)+':00:00.000Z',leftAt:day+'T1'+(i%9)+':00:00.000Z'});}
for(const m of s.members){const op=s.visits.filter(v=>v.member===m.id&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:00:00.000Z';}
const {metadata,entities}=splitState(s);
await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',['A',JSON.stringify({...metadata,_entityStorage:1}),'2026-03-15']);
for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',['A',e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
await real.query("SELECT gymos.backfill_member_summaries('A')");
const branch=big.branch,serverNow=Date.parse('2026-03-15T12:00:00.000Z');

const strictBundle=(await esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import C from './app/member-console.tsx';const p=window.__P;createRoot(document.getElementById('r')).render(React.createElement(C,{...p,mutate:async()=>true,reload:async()=>{}}));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'local-css'},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES':'"1"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_HISTORY':'"0"','process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT':'"1"'},alias:{'next/image':'/tmp/gymeg/tests/browser-img-stub.tsx'},external:[],outdir:'/tmp/hout'})).outputFiles;
const legacyBundle=(await esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import C from './app/member-console.tsx';const p=window.__P;createRoot(document.getElementById('r')).render(React.createElement(C,{...p,mutate:async()=>true,reload:async()=>{}}));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'local-css'},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES':'"0"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_HISTORY':'"0"','process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT':'"0"'},alias:{'next/image':'/tmp/gymeg/tests/browser-img-stub.tsx'},external:[],outdir:'/tmp/hout'})).outputFiles;
const pick=(fs,ext)=>fs.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');const js=pick(strictBundle,'.js'),css=pick(strictBundle,'.css'),jsL=pick(legacyBundle,'.js'),cssL=pick(legacyBundle,'.css');
const calls=[];let failDetail=0,delayDetail=0;
const mkProps=(ar,legacy)=>JSON.stringify({state:{...s,visits:legacy?s.visits:[],events:[],receipts:[]},branch,owner:'t-A',actor:'staff',role,busy:false,serverNow:Date.now(),ar});
const server=http.createServer(async(rq,rs)=>{
 if(/^\/api\/workspace\/(member-candidates|member-detail|member-history)/.test(rq.url)){calls.push(rq.url);
  if(rq.url.includes('member-detail')){if(delayDetail)await new Promise(r=>setTimeout(r,delayDetail));if(failDetail>0){failDetail--;rs.writeHead(503,{'content-type':'application/json'});return rs.end('{"error":"budget"}');}}
  const h=rq.url.includes('member-candidates')?cand:rq.url.includes('member-detail')?det:hist;const r=await h.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':rq.headers['x-gymos-tenant']??''}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url.startsWith('/app-l.js')){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(jsL);}
 if(rq.url.startsWith('/app.js')){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js);}
 const ar=rq.url.includes('ar'),lg=rq.url.includes('legacy');rs.writeHead(200,{'content-type':'text/html'});rs.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>${lg?cssL:css}</style><script>window.process={env:{}}</script><div id=r></div><script>window.__P=${mkProps(ar,lg).replace(/</g,'\\u003c')}</script><script src="${lg?'/app-l.js':'/app.js'}"></script>`);});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
let ok=true;const check=(c,msg)=>{console.log(c?'PASS':'FAIL',msg);if(!c)ok=false;};
const T0=Date.now();const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const openBig=async page=>{await page.waitForSelector('tbody tr',{timeout:10000});await sleep(1200);const rows=await page.$$eval('tbody tr',e=>e.map(x=>x.innerText));const i=rows.findIndex(r=>r.includes(big.name));const b=await (await page.$$('tbody tr'))[i].$('button');await b.click();};
const detailText=page=>page.evaluate(()=>{const d=document.querySelector('[class*="details"]');return d?d.innerText.replace(/\s+/g,' ').trim():null;});
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
try{
 for(const [tag,ar,w,h] of [['desktop',false,1280,900],['mobile',false,390,844],['mobile-ar',true,390,844]]){
  const page=await browser.newPage();await page.setViewport({width:w,height:h});page.on('pageerror',x=>console.log('pageerror:',String(x.stack??x).slice(0,800)));
  // loading
  calls.length=0;delayDetail=1500;failDetail=0;await page.goto(`http://localhost:${port}/${ar?'ar':'en'}`);await openBig(page);await sleep(500);
  let t=await detailText(page);check(/Loading|جارٍ التحميل/.test(t??''),`${tag}: strict loading state shown: ${t?.slice(0,80)}`);
  check(!/\b0\b/.test((t??'').replace(big.name,''))&&!/Check-in/.test(t??''),`${tag}: loading shows no zero count or visit rows`);
  await page.screenshot({path:`/downloads/mc-strict-loading-${tag}.png`});
  await sleep(3500);delayDetail=0;
  t=await detailText(page);t=await detailText(page);check(t&&!/Loading|جارٍ التحميل/.test(t)&&t.includes(big.name),`${tag}: detail renders after load`);
  const strictText=t;await page.close();
  { // intended full-state semantics: the legacy console (no summaries, FULL packet visits, same clock) must show the identical detail text
    const lp=await browser.newPage();await lp.setViewport({width:w,height:h});await lp.goto(`http://localhost:${port}/legacy${ar?'ar':''}`);await openBig(lp);await sleep(800);const lt=await detailText(lp);
    check(lt&&lt===strictText,`${tag}: strict detail text equals the legacy full-state detail text (${lt?.length} chars)`);if(lt!==strictText){console.log('LEGACY:',lt?.slice(0,500));console.log('STRICT:',strictText?.slice(0,500));}
    const mustHave=await lp.evaluate(()=>document.body.innerText);check(/\d/.test(lt??''),`${tag}: legacy detail has numeric facts`);await lp.close();}
  // error + retry
  const p2=await browser.newPage();await p2.setViewport({width:w,height:h});calls.length=0;failDetail=1;await p2.goto(`http://localhost:${port}/${ar?'ar':'en'}`);await openBig(p2);await sleep(1500);
  t=await detailText(p2);check(/Could not load|تعذر تحميل/.test(t??'')&&/Retry|إعادة المحاولة/.test(t??''),`${tag}: error state with Retry: ${t?.slice(0,90)}`);
  check(!/Check-in/.test(t??'')&&!/\b0 visits\b/.test(t??''),`${tag}: error shows no visit/zero data`);
  await p2.screenshot({path:`/downloads/mc-strict-error-${tag}.png`});
  const n0=calls.filter(c=>c.includes('member-detail')).length;
  await p2.evaluate(()=>[...document.querySelectorAll('button')].find(x=>/^(Retry|إعادة المحاولة)$/.test(x.textContent.trim())).click());await sleep(1500);
  const n1=calls.filter(c=>c.includes('member-detail')).length;check(n1>n0,`${tag}: Retry refetches (${n0}->${n1})`);
  t=await detailText(p2);check(t&&!/Could not load|تعذر تحميل|Loading|جارٍ التحميل/.test(t)&&t.includes(big.name)&&t.length>200,`${tag}: detail after Retry`);
  check(!await overflow(p2),`${tag}: no horizontal overflow`);
  await p2.screenshot({path:`/downloads/mc-strict-ok-${tag}.png`});
  await p2.close();
 }
}finally{await browser.close();server.close();}
console.log(ok?'ALL PASS':'FAILURES');process.exit(ok?0:1);
