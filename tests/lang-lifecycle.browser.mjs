// Optional real-browser check (needs /tmp/harness with esbuild + puppeteer-core, and Chrome; not in the runner).
// Real-Chrome lifecycle check of <html lang/dir> across PublicSite <-> Workspace swaps (host component swaps pages in one commit like client navigation). Renders the REAL Workspace with settings.theme='pushtorq-light' (local synthetic club, no network, no production data).
import {createRequire} from 'node:module';import http from 'node:http';import fs from 'node:fs';
const req=createRequire('/tmp/harness/');const esbuild=req('esbuild'),puppeteer=req('puppeteer-core');
const {emptyState,applyOperation}=await import('../app/lib/domain.ts');const {randomUUID}=await import('node:crypto');
const THEME=process.env.THEME??'pushtorq-light';
const nowIso=new Date().toISOString(),d=nowIso.slice(0,10);
const op=(s,type,extra={},at=nowIso)=>applyOperation(s,{type,branch:'main',...extra},at,'QA',randomUUID);
let s=op(emptyState(),'member.save',{name:'عضو اختبار كامل',phone:'01000000001',joined:d,expires:d});s=op(s,'card.issue',{id:s.members[0].id});s=op(s,'plan.save',{name:'باقة اختبار',days:30,visits:null,minor:10000});
const id=s.members[0].id,plan=s.plans[0].id;s=op(s,'plan.assign',{id,plan,start:d,due:d,paid:0,method:'cash',startMode:'replaceCurrent',confirmReplace:true});s=op(s,'plan.assign',{id,plan,start:d,due:d,paid:0,method:'cash'});
const base=Date.parse(nowIso);for(let i=0;i<9;i++)s=op(s,'class.add',{title:'حصة طويلة الاسم رقم '+i+' / Long class title '+i,at:new Date(base+(i%7)*864e5+36e5*(i+1)).toISOString(),capacity:12,minutes:60,coach:'مدرب'});
s.settings.theme=THEME;
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
const pk={state:{...s,events:[],receipts:[]},revision:5,user:{id:'staff',name:'tester'},owner:'t-A',role:'owner',admin:true,serverNow:Date.now(),license:{...license,writable:true,state:'active',maintenance:false}};

const entry=`import {createRoot} from 'react-dom/client';import React from 'react';import W from './app/workspace.tsx';import P from './app/public-site.tsx';
function Host(){const [v,setV]=React.useState('none');window.__go=x=>React.startTransition(()=>setV(x));return v==='pub-en'?React.createElement(P,{en:true}):v==='pub-ar'?React.createElement(P,{en:false}):v==='ws'?React.createElement(W):null;}
createRoot(document.getElementById('r')).render(React.createElement(Host));`;
const b=await esbuild.build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'css','.svg':'dataurl','.png':'dataurl','.jpg':'dataurl','.webp':'dataurl','.json':'json'},define:{'process.env.NODE_ENV':'"development"'},alias:{'next/image':process.cwd()+'/tests/browser-img-stub.tsx'},outdir:'/tmp/hout-life',logLevel:'error'});
const pick=ext=>b.outputFiles.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');const js=pick('.js'),css=pick('.css');
const css2=['app/globals.css','app/gymeg-design.css'].filter(f=>fs.existsSync(f)).map(f=>fs.readFileSync(f,'utf8')).join('\n');
const server=http.createServer((rq,rs)=>{if(rq.url.startsWith('/api/workspace')&&!rq.url.includes('/',14)){rs.writeHead(200,{'content-type':'application/json'});return rs.end(JSON.stringify(pk));}if(rq.url.startsWith('/api/')){rs.writeHead(404,{'content-type':'application/json'});return rs.end('{"error":"x"}');}if(rq.url==='/app.js'){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js);}rs.writeHead(200,{'content-type':'text/html'});rs.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>${css2}\n${css}</style><script>window.process={env:{}};</script><body><div id=r></div><script src="/app.js"></script></body></html>`);});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=true;const rows=[];
const run=async(wsLang)=>{const page=await browser.newPage();const errs=[];page.on('pageerror',e=>errs.push(String(e).slice(0,160)));await page.evaluateOnNewDocument(l=>localStorage.setItem('gymos.language',l),wsLang);await page.goto(`http://localhost:${port}/`);await page.waitForFunction(()=>typeof window.__go==='function');
 const st=()=>page.evaluate(()=>document.documentElement.lang+'/'+document.documentElement.dir);
 const step=async(to,expect)=>{await page.evaluate(x=>window.__go(x),to);await sleep(to==='ws'?2200:700);const got=await st();const pass=got===expect;ok=ok&&pass;rows.push({wsLang,to,expect,got,pass});};
 rows.push({wsLang,to:'initial',got:await st()});
 const wsExpect=wsLang==='ar'?'ar/rtl':'en/ltr';
 await step('pub-en','en/ltr');await step('ws',wsExpect);await step('pub-en','en/ltr');await step('pub-ar','ar/rtl');await step('ws',wsExpect);await step('pub-ar','ar/rtl');await step('pub-en','en/ltr');await step('none',wsExpect);
 rows.push({wsLang,errs});await page.close();};
await run('ar');await run('en');
await browser.close();server.close();console.table?0:0;for(const r of rows)console.log(JSON.stringify(r));console.log(ok?'LIFECYCLE PASS':'LIFECYCLE FAIL');process.exit(ok?0:1);
