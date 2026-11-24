// Optional real-browser check (needs /tmp/harness with esbuild + puppeteer-core, and Chrome; not in the runner).
// Run: node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/visit-trend.browser.mjs
// Renders the REAL Workspace Overview (synthetic club, synthetic days relative to the real clock) with the visit-trend flag OFF / ON / ON+LAZY_STRICT (loading, error+Retry, success), desktop and mobile; compares Overview text and writes screenshots.
import {createRequire} from 'node:module';import http from 'node:http';import fs from 'node:fs';
const req=createRequire('/tmp/harness/');const esbuild=req('esbuild'),puppeteer=req('puppeteer-core');
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;
process.env.GYMOS_QUOTA_ISSUES='1';process.env.GYMOS_LAST_VISITS='1';
const lastRoute=await import('../app/api/workspace/last-visits/route.ts');const vt=await import('../app/api/workspace/quota-issues/route.ts');const wp=await import('../app/api/workspace/route.ts'),vc=await import('../app/api/workspace/changes/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
globalThis.__qaContext={owner:'A',tenantId:'t-A',role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'}};
const s=club(1);
for(const m of s.members){const op=s.visits.filter(v=>v.member===m.id&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:00:00.000Z';}
// distinct daily counts so a wrong window shows: 0..N visits on each of the last 30 days, plus a future-day visit
const TODAY=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo'}).format(new Date()),addD=(d,k)=>new Date(Date.parse(d)+k*864e5).toISOString().slice(0,10);
let n=0;const a=s.members.find(m=>m.branch==='a');for(let d=0;d<30;d++){const day=addD(TODAY,-d);for(let k=0;k<(d*3)%5;k++)s.visits.push({id:'x'+n++,member:a.id,branch:'a',day,at:day+'T0'+k+':00:00.000Z',leftAt:day+'T0'+k+':30:00.000Z'});}
s.visits.push({id:'fut',member:a.id,branch:'a',day:addD(TODAY,3),at:addD(TODAY,3)+'T09:00:00.000Z',leftAt:addD(TODAY,3)+'T10:00:00.000Z'});
// a visit-limited member expiring within 7 days: the quota state decides whether it is Active/Renew soon, so it is exactly what the unknown state must not hide or undercount
const lim=s.members.find(m=>m.branch==='a'&&m.id!==a.id&&!m.archived);lim.expires=addD(TODAY,3);lim.joined='2026-01-01';lim.awaitingSubscription=undefined;lim.freezes=undefined;lim.membershipPeriods=[{id:'plim',plan:'pl-a',start:addD(TODAY,-30),end:addD(TODAY,3),visits:5}];console.log('LIMITED',lim.id,lim.expires);
lim.card='LIM12345';const lim3=s.members.find(m=>m.branch==='a'&&m.id!==a.id&&m.id!==lim.id&&!m.archived&&!m.demo);lim3.expires=addD(TODAY,20);lim3.joined='2026-01-01';lim3.awaitingSubscription=undefined;lim3.freezes=undefined;lim3.card='LIM30001';lim3.membershipPeriods=[{id:'plim3',plan:'pl-a',start:addD(TODAY,-30),end:addD(TODAY,20),visits:1}];console.log('LIMITED1',lim3.id);
s.manualWhatsApp=[{id:'absence',branch:'a',kind:'absence',name:'Absence',body:'Synthetic',enabled:true,offset:7}];
const {metadata,entities}=splitState(s);
await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',['A',JSON.stringify({...metadata,_entityStorage:1}),'2026-03-15']);
for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',['A',e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
await real.query("SELECT gymos.backfill_member_summaries('A')");
const mk=(on,strict)=>esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import W from './app/workspace.tsx';createRoot(document.getElementById('r')).render(React.createElement(W));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'css','.svg':'dataurl','.png':'dataurl','.jpg':'dataurl'},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_GYMOS_LAST_VISITS':on?'"1"':'"0"','process.env.NEXT_PUBLIC_GYMOS_QUOTA_ISSUES':on?'"1"':'"0"','process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT':strict?'"1"':'"0"'},alias:{'next/image':process.cwd()+'/tests/browser-img-stub.tsx'},outdir:'/tmp/hout3',logLevel:'error'}).then(r=>r.outputFiles);
const pick=(fs_,ext)=>fs_.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');
const modes={off:[false,false],on:[true,false],strict:[true,true]};const js={},css={};
for(const [k,[o,st]] of Object.entries(modes)){console.log('BUNDLE',k);const b=await mk(o,st);js[k]=pick(b,'.js');css[k]=pick(b,'.css');}
const css2=['app/globals.css','app/gymeg-design.css'].map(f=>fs.readFileSync(f,'utf8')).join('\n');
const pk={state:{...s,events:[],receipts:[]},revision:5,user:{id:'staff',name:'tester'},owner:'t-A',role:'owner',admin:true,serverNow:Date.now(),license:{...license,writable:true,state:'active',maintenance:false}};
let lastFail=false;const calls=[];let failCode=503;let failNext=0,delayMs=0,drainN=0,cutNext=0,postPacket=null,posts=0,changesCalls=0,omitMode=false,qIn=0,maxIn=0,qAborted=0;
const server=http.createServer(async(rq,rs)=>{
 if(rq.url.startsWith('/api/workspace/last-visits')){const r=lastFail?Response.json({}, {status:503}):await lastRoute.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':'t-A'}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.method==='POST'&&rq.url==='/api/workspace'){posts++;const chunks=[];await new Promise(r=>{rq.on('data',c=>chunks.push(c));rq.on('end',r);});const r=await wp.POST(new Request('https://example.test/api/workspace',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json','X-GymOS-Tenant':'t-A',...(rq.headers['x-gymos-sync-mode']?{'X-GymOS-Sync-Mode':rq.headers['x-gymos-sync-mode']}:{})},body:Buffer.concat(chunks).toString()}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url.startsWith('/api/workspace/changes')){changesCalls++;const r=await vc.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':'t-A'}}));let body=await r.text();if(omitMode){const d=JSON.parse(body);/* what the omitted marker does in applyWorkspaceDeltas: the visit rows never reach the packet, only the revision moves (OMIT_CAPABLE stays false in the product, this is the harness equivalent) */d.events=(d.events??[]).map(e=>e.collection==='visits'?{...e,collection:'__omitted'}:e);body=JSON.stringify(d);}rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(body);}
 if(rq.url.startsWith('/api/workspace/quota-issues')){calls.push(rq.url);qIn++;maxIn=Math.max(maxIn,qIn);rs.on('close',()=>{qIn--;if(!rs.writableFinished)qAborted++;});if(cutNext>0){cutNext--;return rq.socket.destroy();}if(delayMs)await new Promise(r=>setTimeout(r,delayMs));if(drainN>0){drainN--;rs.writeHead(200,{'content-type':'application/json'});return rs.end(JSON.stringify({status:'fallback',reason:'draining',more:true,recomputed:3}));}if(failNext>0){failNext--;rs.writeHead(failCode,{'content-type':'application/json'});return rs.end('{"error":"budget"}');}const r=await vt.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':'t-A'}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url.startsWith('/api/workspace')&&!rq.url.includes('/',14)){rs.writeHead(200,{'content-type':'application/json'});return rs.end(JSON.stringify(rq.headers.referer?.includes('/strict')?{...pk,state:{...pk.state,visits:[]}}:pk));}
 if(rq.url.startsWith('/api/')){rs.writeHead(404,{'content-type':'application/json'});return rs.end('{"error":"x"}');}
 if(rq.url.startsWith('/app-')){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js[rq.url.slice(5,rq.url.indexOf('.'))]);}
 const mode=rq.url.split('/')[1].split('?')[0];if(!js[mode]){rs.writeHead(404);return rs.end();}
 rs.writeHead(200,{'content-type':'text/html'});rs.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>${css2}\n${css[mode]}</style><script>window.process={env:{}};</script><div id=r></div><script src="/app-${mode}.js"></script>`);
});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
let ok=true;const check=(c,msg)=>{console.log(c?'PASS':'FAIL',msg);if(!c)ok=false;};
const OUT=process.env.SHOTS??'/downloads';
const START={en:'Start here',ar:'ابدأ يومك'};
const openOverview=async(page,lang='en')=>{const re=START[lang];await page.waitForFunction(r=>[...document.querySelectorAll('button,a')].some(b=>b.innerText.trim().startsWith(r)),{timeout:15000},re).catch(()=>{});await page.evaluate(r=>[...document.querySelectorAll('button,a')].find(b=>b.innerText.trim().startsWith(r))?.click(),re);await page.waitForSelector('details.card summary',{timeout:8000}).catch(()=>{});await page.evaluate(()=>document.querySelectorAll('details').forEach(d=>d.open=true));await page.waitForSelector('.stats-grid',{timeout:5000}).catch(()=>{});};
const run=async(mode,{settle=2500,drain=0,fail=0,w=1280,h=900,shot,keep=false,lang='en'}={})=>{console.log('RUN',mode,lang);const page=await browser.newPage();page.setDefaultNavigationTimeout(12000);page.setDefaultTimeout(5000);await page.setViewport({width:w,height:h,isMobile:w<600});page.on('console',m=>process.env.DEBUG&&console.log('console:',m.text().slice(0,200)));page.on('requestfailed',r=>process.env.DEBUG&&console.log('reqfail',r.url()));page.on('pageerror',x=>console.log('pageerror:',String(x.stack??x).slice(0,600)));calls.length=0;failNext=fail;drainN=drain;
 await page.evaluateOnNewDocument(l=>localStorage.setItem('gymos.language',l),lang);
 await page.goto(`http://localhost:${port}/${mode}`);await openOverview(page,lang);await new Promise(r=>setTimeout(r,settle));
 if(process.env.DEBUG)console.log('BODY',(await page.$eval('body',e=>e.innerText)).slice(0,1500),await page.evaluate(()=>document.querySelectorAll('details').length));
 const g=sel=>page.$eval(sel,e=>e.innerText.replace(/\s+/g,' ').trim()).catch(()=>'<missing>');
 const out={calls:[...calls],stats:await g('.stats-grid'),ring:await g('.membership-analysis'),hero:await g('.hero-score'),renew:await page.evaluate(()=>{const h=[...document.querySelectorAll('h2')].find(x=>/Ready for the next chapter|قريب من التجديد/.test(x.textContent));const c=h?.closest('.card');return c?c.innerText.replace(/\s+/g,' ').trim():'<missing>';}),chart:await g('.chart-card'),svg:await page.$eval('.chart svg',e=>e.innerHTML.length).catch(()=>-1),paths:await page.$$eval('.chart-card .chart svg path',e=>e.length).catch(()=>0),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),page};if(shot)await (await page.$('.stats-grid')).evaluate(e=>e.scrollIntoView()).then(()=>page.screenshot({path:`${OUT}/${shot}.png`}));if(shot){const el=await page.$('.membership-analysis');if(el){await el.evaluate(e=>e.scrollIntoView({block:'center'}));await new Promise(r=>setTimeout(r,200));const card=await page.evaluateHandle(e=>e.closest('section,article,.card,[class*="card"]')||e.parentElement,el);await (card.asElement()??el).screenshot({path:`${OUT}/${shot}-ring.png`}).catch(()=>{});}}if(!keep)await page.close();return out;};

try{
 for(const lang of ['en','ar']){
  lastFail=false;const off=await run('off',{lang,keep:true,w:390,h:844});
  const legacy=await off.page.$eval('[data-whatsapp-due-count]',e=>e.textContent);await off.page.close();
  lastFail=true;const bad=await run('strict',{lang,keep:true,w:390,h:844});
  check(await bad.page.$eval('[data-whatsapp-due-count]',e=>e.textContent)==='—',lang+' real Overview unknown count');
  const c=await bad.page.$('[data-whatsapp-due-count]');const card=await c.evaluateHandle(e=>e.closest('article'));await card.asElement().screenshot({path:'/downloads/followups-real-overview-error-'+lang+'.png'});
  lastFail=false;await bad.page.evaluate(()=>document.querySelector('[data-whatsapp-due-count]').closest('article').querySelector('button').click());
  await bad.page.waitForFunction(()=>document.querySelector('[data-whatsapp-due-count]')?.textContent!=='—');
  check(await bad.page.$eval('[data-whatsapp-due-count]',e=>e.textContent)===legacy,lang+' real Overview Retry exact legacy');
  await card.asElement().screenshot({path:'/downloads/followups-real-overview-ok-'+lang+'.png'});check(!await bad.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),lang+' real Overview no overflow');await bad.page.close();
 }
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await real.close();}if(!ok)process.exitCode=1;console.log(ok?'ALL PASS':'FAILURES');
