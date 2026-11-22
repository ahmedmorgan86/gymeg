// Optional real-browser check (needs /tmp/harness with esbuild + puppeteer-core, and Chrome; not in the runner).
// Run: node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/visit-trend.browser.mjs
// Renders the REAL Workspace Overview (synthetic club, synthetic days relative to the real clock) with the visit-trend flag OFF / ON / ON+LAZY_STRICT (loading, error+Retry, success), desktop and mobile; compares Overview text and writes screenshots.
import {createRequire} from 'node:module';import http from 'node:http';import fs from 'node:fs';
const req=createRequire('/tmp/harness/');const esbuild=req('esbuild'),puppeteer=req('puppeteer-core');
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;
process.env.GYMOS_VISIT_TREND='1';
const vt=await import('../app/api/workspace/visit-trend/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
globalThis.__qaContext={owner:'A',tenantId:'t-A',role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'}};
const s=club(1);
for(const m of s.members){const op=s.visits.filter(v=>v.member===m.id&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:00:00.000Z';}
// distinct daily counts so a wrong window shows: 0..N visits on each of the last 30 days, plus a future-day visit
const TODAY=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo'}).format(new Date()),addD=(d,k)=>new Date(Date.parse(d)+k*864e5).toISOString().slice(0,10);
let n=0;const a=s.members.find(m=>m.branch==='a');for(let d=0;d<30;d++){const day=addD(TODAY,-d);for(let k=0;k<(d*3)%5;k++)s.visits.push({id:'x'+n++,member:a.id,branch:'a',day,at:day+'T0'+k+':00:00.000Z',leftAt:day+'T0'+k+':30:00.000Z'});}
s.visits.push({id:'fut',member:a.id,branch:'a',day:addD(TODAY,3),at:addD(TODAY,3)+'T09:00:00.000Z',leftAt:addD(TODAY,3)+'T10:00:00.000Z'});
const {metadata,entities}=splitState(s);
await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',['A',JSON.stringify({...metadata,_entityStorage:1}),'2026-03-15']);
for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',['A',e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
const mk=(on,strict)=>esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import W from './app/workspace.tsx';createRoot(document.getElementById('r')).render(React.createElement(W));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'css','.svg':'dataurl','.png':'dataurl','.jpg':'dataurl'},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_GYMOS_VISIT_TREND':on?'"1"':'"0"','process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT':strict?'"1"':'"0"'},alias:{'next/image':process.cwd()+'/tests/browser-img-stub.tsx'},outdir:'/tmp/hout3',logLevel:'error'}).then(r=>r.outputFiles);
const pick=(fs_,ext)=>fs_.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');
const modes={off:[false,false],on:[true,false],strict:[true,true]};const js={},css={};
for(const [k,[o,st]] of Object.entries(modes)){const b=await mk(o,st);js[k]=pick(b,'.js');css[k]=pick(b,'.css');}
const css2=['app/globals.css','app/gymeg-design.css'].map(f=>fs.readFileSync(f,'utf8')).join('\n');
const pk={state:{...s,events:[],receipts:[]},revision:5,user:{id:'staff',name:'tester'},owner:'t-A',role:'owner',admin:true,serverNow:Date.now(),license:{...license,writable:true,state:'active',maintenance:false}};
const calls=[];let failNext=0,delayMs=0;
const server=http.createServer(async(rq,rs)=>{
 if(rq.url.startsWith('/api/workspace/visit-trend')){calls.push(rq.url);if(delayMs)await new Promise(r=>setTimeout(r,delayMs));if(failNext>0){failNext--;rs.writeHead(503,{'content-type':'application/json'});return rs.end('{"error":"budget"}');}const r=await vt.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':'t-A'}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url.startsWith('/api/workspace')&&!rq.url.includes('/',14)){rs.writeHead(200,{'content-type':'application/json'});return rs.end(JSON.stringify(pk));}
 if(rq.url.startsWith('/api/')){rs.writeHead(404,{'content-type':'application/json'});return rs.end('{"error":"x"}');}
 if(rq.url.startsWith('/app-')){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js[rq.url.slice(5,rq.url.indexOf('.'))]);}
 const mode=rq.url.split('/')[1].split('?')[0];if(!js[mode]){rs.writeHead(404);return rs.end();}
 rs.writeHead(200,{'content-type':'text/html'});rs.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>${css2}\n${css[mode]}</style><script>window.process={env:{}};</script><div id=r></div><script src="/app-${mode}.js"></script>`);
});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
let ok=true;const check=(c,msg)=>{console.log(c?'PASS':'FAIL',msg);if(!c)ok=false;};
const OUT=process.env.SHOTS??'/downloads';
const openOverview=async page=>{await page.waitForFunction(()=>[...document.querySelectorAll('button,a')].some(b=>/^\s*Start here/.test(b.innerText)),{timeout:15000}).catch(()=>{});await page.evaluate(()=>[...document.querySelectorAll('button,a')].find(b=>/^\s*Start here/.test(b.innerText))?.click());await page.waitForSelector('details.card summary',{timeout:8000}).catch(()=>{});await page.evaluate(()=>document.querySelectorAll('details').forEach(d=>d.open=true));await page.waitForSelector('.stats-grid',{timeout:5000}).catch(()=>{});};
const run=async(mode,{fail=0,w=1280,h=900,shot,keep=false}={})=>{const page=await browser.newPage();await page.setViewport({width:w,height:h,isMobile:w<600});page.on('console',m=>process.env.DEBUG&&console.log('console:',m.text().slice(0,200)));page.on('requestfailed',r=>process.env.DEBUG&&console.log('reqfail',r.url()));page.on('pageerror',x=>console.log('pageerror:',String(x.stack??x).slice(0,600)));calls.length=0;failNext=fail;
 await page.evaluateOnNewDocument(()=>localStorage.setItem('gymos.language','en'));
 await page.goto(`http://localhost:${port}/${mode}`);await openOverview(page);await new Promise(r=>setTimeout(r,2500));
 if(process.env.DEBUG)console.log('BODY',(await page.$eval('body',e=>e.innerText)).slice(0,1500),await page.evaluate(()=>document.querySelectorAll('details').length));
 const g=sel=>page.$eval(sel,e=>e.innerText.replace(/\s+/g,' ').trim()).catch(()=>'<missing>');
 const out={calls:[...calls],stats:await g('.stats-grid'),chart:await g('.chart-card'),svg:await page.$eval('.chart svg',e=>e.innerHTML.length).catch(()=>-1),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),page};if(shot)await (await page.$('.stats-grid')).evaluate(e=>e.scrollIntoView()).then(()=>page.screenshot({path:`${OUT}/${shot}.png`}));if(!keep)await page.close();return out;};
try{
 const off=await run('off',{shot:'overview-off-desktop'}),on=await run('on',{shot:'overview-on-desktop'});
 console.log('OFF',off.chart.slice(0,300));
 check(off.stats!=='<missing>','Overview rendered');check(off.calls.length===0,'OFF makes no visit-trend request');check(on.calls.length>=1,'ON requests visit-trend: '+on.calls.length);
 check(on.stats===off.stats&&on.chart===off.chart,'Overview stats + pulse text identical OFF vs ON (synthetic club, distinct daily counts, future-day visit)');if(on.chart!==off.chart){console.log('ON ',on.chart.slice(0,300));}
 check(on.svg===off.svg&&on.svg>0,'chart svg markup size identical');
 console.log('strict-fail start');const st=await run('strict',{fail:1,keep:true,shot:'overview-strict-error-desktop'});
 check(/Retry|إعادة/.test(st.chart),'STRICT failure shows Retry');console.log('STRICT-ERR',st.chart.slice(0,200));
 await st.page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>/Retry|إعادة/.test(b.textContent))?.click());await new Promise(r=>setTimeout(r,1500));
 const after=await st.page.$eval('.chart-card',e=>e.innerText.replace(/\s+/g,' ').trim());check(after===off.chart,'STRICT after Retry equals legacy text');
 const ok2=await run('strict',{shot:'overview-strict-ok-desktop'});check(ok2.stats===off.stats&&ok2.chart===off.chart,'STRICT success equals legacy text');
 // loading: a slow first read (server holds the answer 5 s)
 delayMs=5000;const lp=await browser.newPage();await lp.setViewport({width:1280,height:900});await lp.evaluateOnNewDocument(()=>localStorage.setItem('gymos.language','en'));await lp.goto(`http://localhost:${port}/strict`);await openOverview(lp);await new Promise(r=>setTimeout(r,1000));
 const lt=await lp.$eval('.chart-card',e=>e.innerText.replace(/\s+/g,' ').trim()).catch(()=>'<missing>');console.log('LOADING',lt.slice(0,200));check(/Loading/.test(lt),'STRICT loading shows loading notice');await (await lp.$('.stats-grid')).evaluate(e=>e.scrollIntoView());await lp.screenshot({path:`${OUT}/overview-strict-loading-desktop.png`});delayMs=0;await lp.close();
 const mo=await run('off',{w:390,h:844,shot:'overview-off-mobile'}),mn=await run('on',{w:390,h:844,shot:'overview-on-mobile'});check(mo.stats===mn.stats&&mo.chart===mn.chart,'390px Overview text identical OFF vs ON');
 const ms=await run('strict',{fail:1,w:390,h:844,shot:'overview-strict-error-mobile'});check(/Retry/.test(ms.chart),'390px STRICT error shows Retry');
 check(!mn.overflow&&!mo.overflow&&!ms.overflow,'390px no horizontal overflow (ON)');
}finally{await browser.close();server.close();}
console.log(ok?'ALL PASS':'FAILURES');process.exit(ok?0:1);
