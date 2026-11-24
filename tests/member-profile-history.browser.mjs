// Optional real-browser check (not in the runner: needs /tmp/harness with esbuild + puppeteer-core, and Chrome).
// Run: node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/member-profile-strict.browser.mjs
// STRICT history-ON variant: renders the REAL MemberConsole with NEXT_PUBLIC_GYMOS_LAZY_STRICT=1 and summaries ON, packet visits EMPTY (as a strict packet omission would deliver). Original header: Renders the REAL MemberConsole twice (flags OFF = legacy, ON = candidates + detail + paged history) against the REAL routes over PGlite and compares what the user sees.
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


import fs from 'node:fs';
const css2=['app/globals.css','app/gymeg-design.css'].map(f=>fs.readFileSync(f,'utf8')).join('\n');
const out=await esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import P from './app/member-profile.tsx';const p=window.__P;createRoot(document.getElementById('r')).render(React.createElement(P,{...p,onClose(){},mutate:async()=>true}));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'local-css','.svg':'dataurl','.png':'dataurl','.jpg':'dataurl'},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES':'"1"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_HISTORY':'"1"','process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT':'"1"'},alias:{'next/image':process.cwd()+'/tests/browser-img-stub.tsx'},outdir:'/tmp/hout'});
const pick=(fs_,ext)=>fs_.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');const js=pick(out.outputFiles,'.js'),css=pick(out.outputFiles,'.css');
const truth=(await real.query("SELECT count(*)::int n FROM gymos.gym_entities WHERE owner_id='A' AND collection='visits' AND payload->>'member'=$1",[big.id])).rows[0].n;
let failDetail=0,delayDetail=0;
const mkProps=ar=>JSON.stringify({member:big,state:{...s,visits:[],events:[],receipts:[]},owner:'t-A',ar,canEdit:true,financial:true,busy:false});
const server=http.createServer(async(rq,rs)=>{
 if(rq.url.startsWith('/api/workspace/member-history')){const r=await hist.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':'t-A'}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url.startsWith('/api/workspace/member-detail')){if(delayDetail)await new Promise(r=>setTimeout(r,delayDetail));if(failDetail>0){failDetail--;rs.writeHead(503,{'content-type':'application/json'});return rs.end('{"error":"budget"}');}
  const r=await det.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':rq.headers['x-gymos-tenant']??''}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url.startsWith('/app.js')){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js);}
 const ar=rq.url.includes('ar');rs.writeHead(200,{'content-type':'text/html'});rs.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>${css2}\n${css}</style><script>window.process={env:{}}</script><div id=r></div><script>window.__P=${mkProps(ar).replace(/</g,'\\u003c')}</script><script src="/app.js"></script>`);});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
let ok=true;const check=(c,msg)=>{console.log(c?'PASS':'FAIL',msg);if(!c)ok=false;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const visitsLine=p=>p.evaluate(()=>{const e=[...document.querySelectorAll('p')].find(x=>/^(Visits|الزيارات):/.test(x.textContent.trim()));return e?e.textContent.trim():null;});
try{
 for(const [tag,ar,w,h] of [['desktop',false,1280,900],['mobile',false,390,844],['mobile-ar',true,390,844]]){
  const lab=ar?'الزيارات:':'Visits:';
  let page=await browser.newPage();await page.setViewport({width:w,height:h});page.on('pageerror',x=>console.log('pageerror:',String(x.stack??x).slice(0,600)));
  delayDetail=1500;failDetail=0;await page.goto(`http://localhost:${port}/${ar?'ar':'en'}`);await sleep(600);
  let v=await visitsLine(page);check(v!==null&&/—/.test(v)&&!/\d/.test(v.replace(lab,'')),`${tag}: loading shows dash, not 0: ${v}`);
  await page.screenshot({path:`/downloads/mp-strict-loading-${tag}.png`});
  await sleep(4000);v=await visitsLine(page);check(v!==null&&v.includes(String(truth)),`${tag}: after load shows server count ${truth}: ${v}`);
  check(!await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),`${tag}: no horizontal overflow`);
  { // every tab must be reachable: scrollable container, and keyboard focus brings each tab fully into view
    const info=await page.evaluate(async()=>{const tabs=[...document.querySelectorAll('button')].filter(b=>/^(Profile|Attendance|Training|Payments|Health & vitals|Measurements|الملف|الحضور|التدريب|المدفوعات|الصحة|القياسات)/.test(b.textContent.trim())&&b.parentElement&&b.parentElement.children.length>=5);
      if(!tabs.length)return{n:0};const box=tabs[0].parentElement;const cs=getComputedStyle(box);const res={n:tabs.length,scrollW:box.scrollWidth,clientW:box.clientWidth,ox:cs.overflowX,hidden:[],partialAfterFocus:[]};
      for(const b of tabs){b.focus();await new Promise(r=>setTimeout(r,500));const r=b.getBoundingClientRect(),c=box.getBoundingClientRect();const vis=r.left>=Math.max(c.left,0)-1&&r.right<=Math.min(c.right,window.innerWidth)+1;if(!vis){res.partialAfterFocus.push(b.textContent.trim());b.scrollIntoView({inline:'nearest',block:'nearest'});await new Promise(r=>setTimeout(r,500));const r2=b.getBoundingClientRect(),c2=box.getBoundingClientRect();if(!(r2.left>=Math.max(c2.left,0)-1&&r2.right<=Math.min(c2.right,window.innerWidth)+1))res.hidden.push(b.textContent.trim());}}
      return res;});
    console.log(`${tag}: tabs`,JSON.stringify(info));
    check(info.n===6&&info.hidden.length===0&&info.partialAfterFocus.length===0,`${tag}: all ${info.n} tabs reachable by focus (focused tab must be FULLY visible right after focus; never fully visible even with scrollIntoView: ${info.hidden?.join(',')||'none'}; only partly visible right after keyboard focus (needs a swipe/scroll or the next focus): ${info.partialAfterFocus?.join(',')||'none'}; overflow-x=${info.ox}, scroll ${info.scrollW}/${info.clientW})`);
  }
  await page.screenshot({path:`/downloads/mp-strict-ok-${tag}.png`});await page.close();
  delayDetail=0;failDetail=5;page=await browser.newPage();await page.setViewport({width:w,height:h});await page.goto(`http://localhost:${port}/${ar?'ar':'en'}`);await sleep(2500);
  v=await visitsLine(page);check(v!==null&&/—/.test(v)&&!/\d/.test(v.replace(lab,'')),`${tag}: failed detail keeps dash, never 0: ${v}`);
  check(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>/^(Retry|إعادة المحاولة)$/.test(b.textContent.trim()))),tag+': visit count failure exposes Retry');
  await page.screenshot({path:`/downloads/mp-count-retry-error-${tag}.png`});
  failDetail=0;await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>/^(Retry|إعادة المحاولة)$/.test(b.textContent.trim())).click());await sleep(1200);v=await visitsLine(page);check(v?.includes(String(truth)),tag+': Retry restores exact visit count');
  const att=await page.evaluate(()=>{const b=[...document.querySelectorAll('button,[role=tab]')].find(x=>/Attendance|الحضور|الزيارات/.test(x.textContent));if(b){b.click();return true;}return false;});await sleep(600);
  const st=await page.evaluate(()=>[...document.querySelectorAll('[role=status]')].map(x=>x.textContent).join('|'));
  await page.waitForSelector('[data-testid=visit-pager] p:not([aria-busy])');
  let older;while((older=await page.$('[data-testid=visit-pager] > button'))){await older.click();await page.waitForFunction(()=>!document.querySelector('[data-testid=visit-pager] [aria-busy]'));}
  const rows=await page.$$eval('[data-testid=visit-pager] > p:not([aria-busy])',es=>es.map(e=>e.textContent));
  const expected=s.visits.filter(v=>v.member===big.id).sort((a,b)=>b.at.localeCompare(a.at)).map(v=>new Date(v.at).toLocaleString(ar?'ar-EG':'en-GB',{timeZone:s.settings.timezone}));
  check(att&&JSON.stringify(rows)===JSON.stringify(expected),`${tag}: actual advanced profile paged history equals all legacy visits (${rows.length})`);
  await page.screenshot({path:`/downloads/mp-history-all-${tag}.png`});
  await page.screenshot({path:`/downloads/mp-strict-error-${tag}.png`});await page.close();failDetail=0;
 }
}finally{await browser.close();server.close();}
console.log(ok?'ALL PASS':'FAILURES');process.exit(ok?0:1);
