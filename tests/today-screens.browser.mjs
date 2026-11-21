// Optional real-browser check for DailyHome + Operations (flags OFF / ON / ON+LAZY_STRICT with a failing first read). Needs /tmp/harness (esbuild, puppeteer-core) and Chrome.
// Run: ROLE=owner node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/today-screens.browser.mjs
// Optional real-browser check (not in the runner: needs /tmp/harness with esbuild + puppeteer-core, and Chrome).
// Run: node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/member-console.browser.mjs
// Renders the REAL MemberConsole twice (flags OFF = legacy, ON = candidates + detail + paged history) against the REAL routes over PGlite and compares what the user sees.
import {createRequire} from 'node:module';import http from 'node:http';
const req=createRequire('/tmp/harness/');const esbuild=req('esbuild'),puppeteer=req('puppeteer-core');
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;
process.env.GYMOS_TODAY_VISITS='1';
const tv=await import('../app/api/workspace/today-visits/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
const role=process.env.ROLE??'owner';
globalThis.__qaContext={owner:'A',tenantId:'t-A',role,branches:null,license,user:{userId:'staff',displayName:'tester'}};
const s=club(1);const big=s.members[0];for(let i=0;i<40;i++){const day='2026-02-'+String(1+(i%27)).padStart(2,'0');s.visits.push({id:'pg'+i,member:big.id,branch:big.branch,day,at:day+'T0'+(i%9)+':00:00.000Z',leftAt:day+'T1'+(i%9)+':00:00.000Z'});}
for(const m of s.members){const op=s.visits.filter(v=>v.member===m.id&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:00:00.000Z';}
const {metadata,entities}=splitState(s);
await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',['A',JSON.stringify({...metadata,_entityStorage:1}),'2026-03-15']);
for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',['A',e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
const branch=big.branch,serverNow=Date.parse('2026-03-15T12:00:00.000Z');
const day=s.visits.filter(v=>v.branch===big.branch).reduce((m,v)=>(m[v.day]=(m[v.day]||0)+1,m),{});const today=Object.entries(day).sort((a,b)=>b[1]-a[1])[0][0];
const mk=(on,strict)=>esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import DailyHome from './app/daily-home.tsx';import Operations from './app/operations.tsx';const p=window.__P;const noop=async()=>true;createRoot(document.getElementById('r')).render(React.createElement('div',null,React.createElement('section',{id:'home'},React.createElement(DailyHome,{...p,onTask:()=>{},onMember:()=>{}})),React.createElement('section',{id:'ops'},React.createElement(Operations,{...p,revision:5,busy:false,mutate:noop,reload:noop,checkIn:async()=>'saved',online:true,pendingCount:0,sync:noop,role:p.role==='owner'?'owner':p.role}))));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'local-css'},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_GYMOS_TODAY_VISITS':on?'"1"':'"0"','process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT':strict?'"1"':'"0"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES':'"0"'},alias:{'next/image':'/tmp/gymeg/tests/browser-img-stub.tsx'},external:[],outdir:'/tmp/hout2'}).then(r=>r.outputFiles);
const pick=(fs,ext)=>fs.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');
const modes={off:[false,false],on:[true,false],strict:[true,true]};const js={},css={};for(const [k,[o,st]] of Object.entries(modes)){const b=await mk(o,st);js[k]=pick(b,'.js');css[k]=pick(b,'.css');}
const calls=[];let failNext=0;
const props=JSON.stringify({state:{...s,events:[],receipts:[]},branch,owner:'t-A',role,ar:false,today,canEdit:true,admin:role==='owner'});
const server=http.createServer(async(rq,rs)=>{
 if(rq.url.startsWith('/api/workspace/today-visits')){calls.push(rq.url);if(failNext>0){failNext--;rs.writeHead(503,{'content-type':'application/json'});return rs.end('{"error":"budget"}');}const r=await tv.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':rq.headers['x-gymos-tenant']??''}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url.startsWith('/app-')){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js[rq.url.slice(5,rq.url.indexOf('.'))]);}
 const mode=rq.url.split('/')[1].split('?')[0];rs.writeHead(200,{'content-type':'text/html'});rs.end(`<!doctype html><meta charset=utf-8><style>${css[mode]}</style><script>window.process={env:{}}</script><div id=r></div><script>window.__P=${props.replace(/</g,'\\u003c')}</script><script src="/app-${mode}.js"></script>`);});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
let ok=true;const check=(c,msg)=>{console.log(c?'PASS':'FAIL',msg);if(!c)ok=false;};
const text=(page,sel)=>page.$eval(sel,e=>e.innerText.replace(/\s+/g,' ').trim());
const run=async(mode,fail=0)=>{const page=await browser.newPage();await page.setViewport({width:1280,height:900});page.on('pageerror',x=>console.log('pageerror:',String(x.stack??x).slice(0,800)));calls.length=0;failNext=fail;
 await page.goto(`http://localhost:${port}/${mode}`);await page.waitForSelector('#home',{timeout:10000});await new Promise(r=>setTimeout(r,1800));
 const out={calls:[...calls],home:await text(page,'#home'),ops:await text(page,'#ops')};out.page=page;return out;};
try{
 const off=await run('off'),on=await run('on');
 check(off.calls.length===0,'OFF makes no today-visits request');
 check(on.calls.length>=1,'ON requests today-visits: '+on.calls.length);
 check(on.home===off.home,'DailyHome text identical OFF vs ON');if(on.home!==off.home){console.log('OFF',off.home.slice(0,600));console.log('ON ',on.home.slice(0,600));}
 check(on.ops===off.ops,'Operations text identical OFF vs ON');if(on.ops!==off.ops){console.log('OFF',off.ops.slice(0,800));console.log('ON ',on.ops.slice(0,800));}
 await off.page.screenshot({path:'/downloads/today-screens-off.png'});await on.page.screenshot({path:'/downloads/today-screens-on.png'});
 // strict: first read fails twice (count + latest are one request, debounce), page must show Retry and no zero
 const st=await run('strict',1);const hasRetry=await st.page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>/Retry/.test(b.textContent)));
 check(hasRetry,'STRICT failure shows Retry');check(!/Today.s real member visits: 0/.test(st.home),'STRICT failure never shows a zero count');
 await st.page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>/Retry/.test(b.textContent)).click());await new Promise(r=>setTimeout(r,1200));
 const after={home:await text(st.page,'#home'),ops:await text(st.page,'#ops')};
 check(after.home===off.home&&after.ops===off.ops,'STRICT after Retry equals legacy text');
 const st2=await run('strict',0);check(st2.home===off.home&&st2.ops===off.ops,'STRICT success equals legacy text');
}finally{await browser.close();server.close();}
console.log(ok?'ALL PASS':'FAILURES');process.exit(ok?0:1);
