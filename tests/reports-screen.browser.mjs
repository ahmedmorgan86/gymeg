// Optional real-browser check (needs /tmp/harness with esbuild + puppeteer-core, and Chrome) for the Reports "Collections & receipts" screen:
// OFF (packet expression) vs ON (paged report-payments) vs ON+LAZY_STRICT, with a transient failure (Retry), a budget 503 (narrow dates + Retry) and a deterministic unsupported record (no Retry; strict blanks).
// Run: node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/reports-screen.browser.mjs
import {createRequire} from 'node:module';import http from 'node:http';
const req=createRequire('/tmp/harness/');const esbuild=req('esbuild'),puppeteer=req('puppeteer-core');
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;
process.env.GYMOS_REPORT_PAYMENTS='1';
const route=await import('../app/api/workspace/report-payments/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
globalThis.__qaContext={owner:'A',tenantId:'t-A',role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'}};
const s=club(1);const {metadata,entities}=splitState(s);
await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',['A',JSON.stringify({...metadata,_entityStorage:1}),'2026-03-15']);
for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',['A',e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
const branch=s.payments.reduce((m,p)=>(m[p.branch]=(m[p.branch]||0)+1,m),{}),br=Object.entries(branch).sort((a,b)=>b[1]-a[1])[0][0];
const mk=(on,strict)=>esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import ReportsPage from './app/reports-page.tsx';const p=window.__P;createRoot(document.getElementById('r')).render(React.createElement('div',{id:'rep'},React.createElement(ReportsPage,{...p,financial:true,admin:true,canExport:true})));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'local-css'},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_GYMOS_REPORT_PAYMENTS':on?'"1"':'"0"','process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT':strict?'"1"':'"0"'},alias:{'next/image':'/tmp/gymeg/tests/browser-img-stub.tsx'},external:[],outdir:'/tmp/hout3'}).then(r=>r.outputFiles);
const pick=(fs,ext)=>fs.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');
const js={},css={};for(const [k,[o,st]] of Object.entries({off:[false,false],on:[true,false],strict:[true,true]})){const b=await mk(o,st);js[k]=pick(b,'.js');css[k]=pick(b,'.css');}
const calls=[];let failNext=0,failCode=500;
const props=JSON.stringify({state:{...s,events:[],receipts:[]},branch:br,owner:'t-A',ar:false});
const server=http.createServer(async(rq,rs)=>{
 if(rq.url.startsWith('/api/workspace/report-payments')){calls.push(rq.url);if(failNext>0){failNext--;rs.writeHead(failCode,{'content-type':'application/json'});return rs.end(failCode===503?'{"error":"budget"}':'{"error":"server"}');}const r=await route.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':rq.headers['x-gymos-tenant']??''}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url.startsWith('/app-')){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js[rq.url.slice(5,rq.url.indexOf('.'))]);}
 const mode=rq.url.split('/')[1].split('?')[0];rs.writeHead(200,{'content-type':'text/html'});rs.end(`<!doctype html><meta charset=utf-8><style>${css[mode]}</style><script>window.process={env:{}}</script><div id=r></div><script>window.__P=${props.replace(/</g,'\\u003c')}</script><script src="/app-${mode}.js"></script>`);});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
let ok=true;const check=(c,msg)=>{console.log(c?'PASS':'FAIL',msg);if(!c)ok=false;};
const text=page=>page.$eval('#rep',e=>e.innerText.replace(/\s+/g,' ').trim());
const run=async(mode,fail=0,code=500,shot)=>{const page=await browser.newPage();await page.setViewport({width:1280,height:1100});page.on('pageerror',x=>console.log('pageerror:',String(x.stack??x).slice(0,600)));
 await page.evaluateOnNewDocument(()=>{const R=Date,F=new R('2026-03-15T12:00:00Z').getTime();globalThis.Date=class extends R{constructor(...a){a.length?super(...a):super(F);}static now(){return F;}};});
 calls.length=0;failNext=fail;failCode=code;await page.goto(`http://localhost:${port}/${mode}`);await page.waitForSelector('#rep',{timeout:10000});await new Promise(r=>setTimeout(r,1800));
 const out={calls:[...calls],text:await text(page),page,retry:await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>/^Retry$/.test(b.textContent.trim())))};if(shot)await page.screenshot({path:shot});return out;};
const stat=t=>(t.match(/Valid total[^A-Za-z]*([£\d.,]+)/)||[])[1];
try{
 const off=await run('off'),on=await run('on');
 check(off.calls.length===0,'OFF makes no report-payments request');check(on.calls.length>=1,'ON requests report-payments: '+on.calls.length);
 check(on.text===off.text,'Reports text identical OFF vs ON (rows, totals, paging)');if(on.text!==off.text){console.log('OFF',off.text.slice(0,700));console.log('ON ',on.text.slice(0,700));}
 const st=await run('strict',1,500,'/downloads/reports-strict-retry.png');
 check(st.retry,'STRICT transient failure shows Retry');check(/Could not load collections/.test(st.text),'STRICT failure notice text');const money=page=>page.evaluate(()=>[...document.querySelectorAll('tbody tr')].filter(r=>/Membership|External coaching|Advance credit/.test(r.children[3]?.textContent??'')).length);
 check((await money(st.page))===0,'STRICT failure shows no packet-derived payment rows (shop rows stay packet-sourced)');
 await st.page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>/^Retry$/.test(b.textContent.trim())).click());await new Promise(r=>setTimeout(r,1500));
 check((await text(st.page))===off.text,'STRICT after Retry equals legacy text');
 const big=await run('strict',1,503,'/downloads/reports-toolarge.png');check(/too large to load at once/.test(big.text)&&big.retry,'budget 503 shows narrow-dates notice with Retry');
 const strictOk=await run('strict');check(strictOk.text===off.text,'STRICT success equals legacy text');
 // deterministic unsupported record: a member whose name is a number
 const m0=s.members.find(m=>s.payments.some(p=>p.member===m.id&&p.branch===br));
 await real.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{name}','5') WHERE owner_id='A' AND collection='members' AND entity_id=$1",[m0.id]);
 const un=await run('on',0,500,'/downloads/reports-unsupported.png');check(/retrying will not change that/.test(un.text)&&!un.retry,'unsupported record: explicit notice, no Retry');
 const unS=await run('strict');check(/retrying will not change that/.test(unS.text)&&!unS.retry&&(await money(unS.page))===0,'unsupported + strict: notice, blank table, no Retry');
}finally{await browser.close();server.close();}
console.log(ok?'ALL PASS':'FAILURES');process.exit(ok?0:1);
