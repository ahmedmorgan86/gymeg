// Optional real-browser check (needs /tmp/harness with esbuild + puppeteer-core, and Chrome; not in the runner).
// Run: node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/visit-trend.browser.mjs
// Renders the REAL Workspace Overview (synthetic club, synthetic days relative to the real clock) with the visit-trend flag OFF / ON / ON+LAZY_STRICT (loading, error+Retry, success), desktop and mobile; compares Overview text and writes screenshots.
import {createRequire} from 'node:module';import http from 'node:http';import fs from 'node:fs';
const req=createRequire('/tmp/harness/');const esbuild=req('esbuild'),puppeteer=req('puppeteer-core');
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;
process.env.GYMOS_QUOTA_ISSUES='1';
const vt=await import('../app/api/workspace/quota-issues/route.ts');
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
await real.query("SELECT gymos.backfill_member_summaries('A')");
const mk=(on,strict)=>esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import W from './app/workspace.tsx';createRoot(document.getElementById('r')).render(React.createElement(W));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'css','.svg':'dataurl','.png':'dataurl','.jpg':'dataurl'},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_GYMOS_QUOTA_ISSUES':on?'"1"':'"0"','process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT':strict?'"1"':'"0"'},alias:{'next/image':process.cwd()+'/tests/browser-img-stub.tsx'},outdir:'/tmp/hout3',logLevel:'error'}).then(r=>r.outputFiles);
const pick=(fs_,ext)=>fs_.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');
const modes={off:[false,false],on:[true,false],strict:[true,true]};const js={},css={};
for(const [k,[o,st]] of Object.entries(modes)){const b=await mk(o,st);js[k]=pick(b,'.js');css[k]=pick(b,'.css');}
const css2=['app/globals.css','app/gymeg-design.css'].map(f=>fs.readFileSync(f,'utf8')).join('\n');
const pk={state:{...s,events:[],receipts:[]},revision:5,user:{id:'staff',name:'tester'},owner:'t-A',role:'owner',admin:true,serverNow:Date.now(),license:{...license,writable:true,state:'active',maintenance:false}};
const calls=[];let failNext=0,delayMs=0,drainN=0;
const server=http.createServer(async(rq,rs)=>{
 if(rq.url.startsWith('/api/workspace/quota-issues')){calls.push(rq.url);if(delayMs)await new Promise(r=>setTimeout(r,delayMs));if(drainN>0){drainN--;rs.writeHead(200,{'content-type':'application/json'});return rs.end(JSON.stringify({status:'fallback',reason:'draining',more:true,recomputed:3}));}if(failNext>0){failNext--;rs.writeHead(503,{'content-type':'application/json'});return rs.end('{"error":"budget"}');}const r=await vt.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':'t-A'}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
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
const START={en:'Start here',ar:'ابدأ يومك'};
const openOverview=async(page,lang='en')=>{const re=START[lang];await page.waitForFunction(r=>[...document.querySelectorAll('button,a')].some(b=>b.innerText.trim().startsWith(r)),{timeout:15000},re).catch(()=>{});await page.evaluate(r=>[...document.querySelectorAll('button,a')].find(b=>b.innerText.trim().startsWith(r))?.click(),re);await page.waitForSelector('details.card summary',{timeout:8000}).catch(()=>{});await page.evaluate(()=>document.querySelectorAll('details').forEach(d=>d.open=true));await page.waitForSelector('.stats-grid',{timeout:5000}).catch(()=>{});};
const run=async(mode,{settle=2500,drain=0,fail=0,w=1280,h=900,shot,keep=false,lang='en'}={})=>{const page=await browser.newPage();await page.setViewport({width:w,height:h,isMobile:w<600});page.on('console',m=>process.env.DEBUG&&console.log('console:',m.text().slice(0,200)));page.on('requestfailed',r=>process.env.DEBUG&&console.log('reqfail',r.url()));page.on('pageerror',x=>console.log('pageerror:',String(x.stack??x).slice(0,600)));calls.length=0;failNext=fail;drainN=drain;
 await page.evaluateOnNewDocument(l=>localStorage.setItem('gymos.language',l),lang);
 await page.goto(`http://localhost:${port}/${mode}`);await openOverview(page,lang);await new Promise(r=>setTimeout(r,settle));
 if(process.env.DEBUG)console.log('BODY',(await page.$eval('body',e=>e.innerText)).slice(0,1500),await page.evaluate(()=>document.querySelectorAll('details').length));
 const g=sel=>page.$eval(sel,e=>e.innerText.replace(/\s+/g,' ').trim()).catch(()=>'<missing>');
 const out={calls:[...calls],stats:await g('.stats-grid'),ring:await g('.membership-analysis'),chart:await g('.chart-card'),svg:await page.$eval('.chart svg',e=>e.innerHTML.length).catch(()=>-1),paths:await page.$$eval('.chart-card .chart svg path',e=>e.length).catch(()=>0),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),page};if(shot)await (await page.$('.stats-grid')).evaluate(e=>e.scrollIntoView()).then(()=>page.screenshot({path:`${OUT}/${shot}.png`}));if(!keep)await page.close();return out;};
let bv=null;
try{
 const off=await run('off',{shot:'quota-off-desktop'}),on=await run('on',{shot:'quota-on-desktop'});
 console.log('OFF',off.stats.slice(0,200));
 check(off.stats!=='<missing>'&&off.ring!=='<missing>','Overview rendered');check(off.calls.length===0,'OFF makes no quota-issues request');check(on.calls.length>=1,'ON requests quota-issues: '+on.calls.length);
 check(on.stats===off.stats&&on.ring===off.ring,'ON success: Overview stats + membership ring text identical to legacy');if(on.ring!==off.ring)console.log('ON',on.ring.slice(0,300),'OFF',off.ring.slice(0,300));
 const st=await run('strict',{fail:1,keep:true,shot:'quota-strict-error-desktop'});
 check(/Active members —/.test(st.stats),'STRICT failure: Active members shows a dash, not a count: '+st.stats.slice(0,120));check(/Retry|إعادة/.test(st.ring+st.stats),'STRICT failure shows Retry');check(!/Active members \d/.test(st.stats),'STRICT failure shows no numeric Active members');
 await st.page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>/Retry|إعادة/.test(b.textContent))?.click());await new Promise(r=>setTimeout(r,2000));
 const after=await st.page.$eval('.stats-grid',e=>e.innerText.replace(/\s+/g,' ').trim());check(after===off.stats,'STRICT after Retry equals legacy stats');
 const ok2=await run('strict',{shot:'quota-strict-ok-desktop'});check(ok2.stats===off.stats&&ok2.ring===off.ring,'STRICT success equals legacy stats + ring');
 const mid=await run('strict',{drain:6,settle:1500,shot:'quota-strict-draining-desktop'});console.log('DRAIN-MID',mid.stats.slice(0,60),'|',mid.ring.slice(-60));check(/Active members —/.test(mid.stats)&&/Preparing quota status/.test(mid.ring+mid.stats),'STRICT draining mid-state: dash + progress text');
 const dr=await run('strict',{drain:3,settle:14000});check(dr.stats===off.stats,'STRICT draining x3 then ok: final stats equal legacy, calls='+dr.calls.length);
 drainN=0;failNext=0;delayMs=4000;const lp=await browser.newPage();await lp.setViewport({width:1280,height:900});await lp.evaluateOnNewDocument(()=>localStorage.setItem('gymos.language','en'));await lp.goto(`http://localhost:${port}/strict`);await openOverview(lp);await new Promise(r=>setTimeout(r,1000));
 const lt=await lp.$eval('.stats-grid',e=>e.innerText.replace(/\s+/g,' ').trim()).catch(()=>'<missing>');console.log('LOADING',lt.slice(0,160));check(/Active members —/.test(lt),'STRICT loading: dash, no count');await (await lp.$('.stats-grid')).evaluate(e=>e.scrollIntoView()).catch(()=>{});await lp.screenshot({path:`${OUT}/quota-strict-loading-desktop.png`});delayMs=0;
 const mo=await run('off',{w:390,h:844,shot:'quota-off-mobile'}),mn=await run('on',{w:390,h:844,shot:'quota-on-mobile'});check(mo.stats===mn.stats&&mo.ring===mn.ring,'390px ON text equals OFF');
 const ms=await run('strict',{fail:1,w:390,h:844,shot:'quota-strict-error-mobile'});check(/Active members —/.test(ms.stats)&&/Retry/.test(ms.ring+ms.stats),'390px STRICT error: dash + Retry');
 const mdm=await run('strict',{drain:6,settle:1500,w:390,h:844,shot:'quota-strict-draining-mobile'});check(/Active members —/.test(mdm.stats)&&/Preparing quota status/.test(mdm.ring+mdm.stats)&&!mdm.overflow,'390px draining mid-state: dash + progress, no overflow');const md=await run('strict',{drain:2,settle:12000,w:390,h:844,shot:'quota-strict-drained-mobile'});check(md.stats===mo.stats,'390px STRICT draining then ok equals legacy');
 const aoff=await run('off',{w:390,h:844,lang:'ar',shot:'quota-off-mobile-ar'}),aon=await run('on',{w:390,h:844,lang:'ar',shot:'quota-on-mobile-ar'}),aerr=await run('strict',{fail:1,w:390,h:844,lang:'ar',shot:'quota-strict-error-mobile-ar'}),adm=await run('strict',{drain:6,settle:1500,w:390,h:844,lang:'ar',shot:'quota-strict-draining-mobile-ar'}),adr=await run('strict',{drain:2,settle:12000,w:390,h:844,lang:'ar'}),aok=await run('strict',{w:390,h:844,lang:'ar',shot:'quota-strict-ok-mobile-ar'});
 check(aoff.stats===aon.stats&&aoff.stats===aok.stats&&aoff.stats===adr.stats,'390px Arabic: ON, STRICT ok and STRICT draining-then-ok equal legacy');console.log('AR-DRAIN-MID',adm.stats.slice(0,60),'|',adm.ring.slice(-70));check(/—/.test(adm.stats)&&!adm.overflow,'390px Arabic draining mid-state: dash, no overflow');console.log('AR-ERR',aerr.stats.slice(0,160));check(/—/.test(aerr.stats)&&/إعادة المحاولة/.test(aerr.ring+aerr.stats)&&!aerr.overflow&&!aoff.overflow&&!aok.overflow&&!adr.overflow,'390px Arabic error: dash + Retry, no overflow anywhere');
 check(!mn.overflow&&!mo.overflow&&!ms.overflow&&!md.overflow,'390px no horizontal overflow');
}finally{await browser.close();server.close();}
console.log(ok?'ALL PASS':'FAILURES');process.exit(ok?0:1);
