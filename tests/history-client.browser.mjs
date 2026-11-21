// Optional real-browser check (not in the runner: needs /tmp/harness with esbuild + puppeteer-core, and Chrome).
// Run: node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/history-client.browser.mjs
// Serves the REAL member-visit-pager component (bundled) and the REAL member-history route over PGlite, then drives Chrome.
import {createRequire} from 'node:module';import http from 'node:http';import {writeFileSync} from 'node:fs';
const req=createRequire('/tmp/harness/');const esbuild=req('esbuild'),puppeteer=req('puppeteer-core');
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;
const {GET}=await import('../app/api/workspace/member-history/route.ts');const {splitState}=await import('../app/lib/entity-state.ts');const {club}=await import('./hot-ops-fixture.mjs');
process.env.GYMOS_MEMBER_HISTORY='1';
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
globalThis.__qaContext={owner:'A',tenantId:'t-A',role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'}};
const s=club(1);{const mm=s.members[0];for(let i=0;i<23;i++){const day='2026-02-'+String(1+(i%27)).padStart(2,'0');s.visits.push({id:'pg'+i,member:mm.id,branch:mm.branch,day,at:day+'T09:00:00.000Z',leftAt:day+'T10:00:00.000Z'});}}
const {metadata,entities}=splitState(s);
await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',['A',JSON.stringify({...metadata,_entityStorage:1}),'2026-03-15']);
for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',['A',e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
const m=s.members.map(x=>({x,n:s.visits.filter(v=>v.member===x.id).length})).sort((a,b)=>b.n-a.n)[0];
const b=await esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import P from './app/member-visit-pager.tsx';createRoot(document.getElementById('r')).render(React.createElement(P,{member:${JSON.stringify(m.x.id)},owner:'t-A',ar:false,timeZone:'Africa/Cairo',pageSize:5}));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_HISTORY':'"1"'},jsx:'automatic'});
const js=b.outputFiles[0].text;let apiCalls=[],failNext=0;
const server=http.createServer(async(rq,rs)=>{if(rq.url.startsWith('/api/workspace/member-history')){apiCalls.push(rq.url);if(failNext>0){failNext--;rs.writeHead(500);return rs.end('{}');}
 const r=await GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':rq.headers['x-gymos-tenant']??''}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url==='/app.js'){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js);}rs.writeHead(200,{'content-type':'text/html'});rs.end('<!doctype html><meta charset=utf-8><div id=r></div><script src="/app.js"></script>');});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
let ok=true;const check=(c,msg)=>{console.log(c?'PASS':'FAIL',msg);if(!c)ok=false;};
try{
 const page=await browser.newPage();await page.setViewport({width:480,height:700});page.on('console',x=>console.log('console:',x.text()));page.on('pageerror',x=>console.log('pageerror:',String(x).slice(0,300)));await page.goto(`http://localhost:${port}/`);
 const count=()=>page.$$eval('[data-testid=visit-pager] p:not([aria-busy])',e=>e.length);
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid=visit-pager] p').length>=5,{timeout:8000}).catch(async()=>{console.log('HTML',(await page.content()).slice(-600),'calls',apiCalls);throw Error('first page');});
 check(await count()===5,`first page shows 5 rows (member has ${m.n} visits)`);check(apiCalls.length===1&&/limit=5/.test(apiCalls[0]),'one bounded request: '+apiCalls[0]);
 await page.screenshot({path:'/downloads/history-client-page1.png'});
 const expected=s.visits.filter(v=>v.member===m.x.id).map(v=>v.at).reverse() /* route contract: newest position first */;let shown=5;
 while(shown<m.n){const btn=await page.$('button');check(!!btn,'Show older present while rows remain');if(!btn)break;await btn.click();const want=Math.min(m.n,shown+5);await page.waitForFunction(w=>document.querySelectorAll('[data-testid=visit-pager] p:not([aria-busy])').length>=w,{},want);shown=want;}
 const texts=await page.$$eval('[data-testid=visit-pager] p',e=>e.map(x=>x.textContent));
 const fmt=at=>new Date(at).toLocaleString('en-GB',{timeZone:'Africa/Cairo'});
 check(texts.length===m.n&&texts.every((t,i)=>t===fmt(expected[i])),'all pages, newest first, equal the member visit list ('+texts.length+' rows)');
 check(!await page.$('[data-testid=visit-pager] > button'),'no Show older button after the last page');
 await page.screenshot({path:'/downloads/history-client-all.png'});
 // error path with retry
 apiCalls=[];failNext=1;await page.reload();await page.waitForSelector('[role=alert]');check(true,'server error shows an alert');await page.screenshot({path:'/downloads/history-client-error.png'});
 await (await page.$('[role=alert] button')).click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid=visit-pager] p').length>=5&&!document.querySelector('[role=alert]'));check(true,'retry recovers');
 check(!apiCalls.some(u=>/collection=(payments|invoices)/.test(u)),'no other collection requested');
}finally{await browser.close();server.close();await real.close();}
process.exit(ok?0:1);
