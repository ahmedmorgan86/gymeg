// Optional real-browser check (needs /tmp/harness with esbuild + puppeteer-core, and Chrome; not in the runner).
// Renders the REAL Workspace with settings.theme='pushtorq-light' (local synthetic club, no network, no production data).
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
const b=await esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import W from './app/workspace.tsx';createRoot(document.getElementById('r')).render(React.createElement(W));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'css','.svg':'dataurl','.png':'dataurl','.jpg':'dataurl'},define:{'process.env.NODE_ENV':'"development"'},alias:{'next/image':process.cwd()+'/tests/browser-img-stub.tsx'},outdir:'/tmp/hout-light',logLevel:'error'});
const pick=ext=>b.outputFiles.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');const js=pick('.js'),css=pick('.css');
const css2=['app/globals.css','app/gymeg-design.css'].filter(f=>fs.existsSync(f)).map(f=>fs.readFileSync(f,'utf8')).join('\n');
const server=http.createServer((rq,rs)=>{if(rq.url.startsWith('/api/workspace')&&!rq.url.includes('/',14)){rs.writeHead(200,{'content-type':'application/json'});return rs.end(JSON.stringify(pk));}if(rq.url.startsWith('/api/')){rs.writeHead(404,{'content-type':'application/json'});return rs.end('{"error":"x"}');}if(rq.url==='/app.js'){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js);}rs.writeHead(200,{'content-type':'text/html'});rs.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>${css2}\n${css}</style><script>window.process={env:{}};</script><div id=r></div><script src="/app.js"></script>`);});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
const OUT=process.env.SHOTS??'/downloads';const out={theme:THEME};
const clickText=(page,re)=>page.evaluate(r=>{const el=[...document.querySelectorAll('button,a,summary')].find(b=>new RegExp(r).test(b.innerText.trim()));if(el){el.click();return el.innerText.trim();}return null;},re);
const lum=c=>{const m=c.match(/[\d.]+/g).map(Number);const f=v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;};return .2126*f(m[0])+.7152*f(m[1])+.0722*f(m[2]);};
const cr=(a,b)=>{const x=lum(a),y=lum(b);return +((Math.max(x,y)+.05)/(Math.min(x,y)+.05)).toFixed(2);};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const styleOf=(page,sel)=>page.evaluate(q=>{const e=document.querySelector(q);if(!e)return null;const c=getComputedStyle(e);let bg=c.backgroundColor,n=e;while(n&&/rgba\(0, 0, 0, 0\)|transparent/.test(bg)){n=n.parentElement;bg=n?getComputedStyle(n).backgroundColor:'rgb(255,255,255)';}return {color:c.color,bg,w:Math.round(e.getBoundingClientRect().width)};},sel);
for(const lang of ['ar','en']){const page=await browser.newPage();await page.setViewport({width:1440,height:1000});await page.evaluateOnNewDocument(l=>localStorage.setItem('gymos.language',l),lang);const errs=[];page.on('pageerror',e=>errs.push(String(e).slice(0,160)));
 await page.goto(`http://localhost:${port}/`);await sleep(2500);const r={errs,rootScheme:await page.evaluate(()=>document.documentElement.style.colorScheme),rootBg:await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()||getComputedStyle(document.documentElement).getPropertyValue('--surface').trim())};
 r.view=await clickText(page,'^(عرض التفاصيل|View details)$');await sleep(1200);
 r.more=await clickText(page,'^(المزيد من الإجراءات|More actions)$');await sleep(300);
 r.renew=await clickText(page,'^(تجديد الاشتراك|Renew subscription)$');await sleep(800);
 r.open=await clickText(page,'^(إلغاء هذه الفترة المستقبلية|Cancel this future term)$');await sleep(500);
 await page.evaluate(()=>{const i=document.querySelector('input[maxlength="500"]');const sec=i&&i.closest('section');if(sec)sec.setAttribute('data-pc','1');});const sec=await page.$('[data-pc]');if(sec){await sec.evaluate(e=>e.scrollIntoView({block:'center'}));await sleep(300);}
 r.cancelSectionFound=Boolean(sec);
 r.noticeP=await page.evaluate(()=>{const e=document.querySelector('[data-pc] p');if(!e)return null;const c=getComputedStyle(e);return {color:c.color,text:e.innerText.slice(0,80)};});
 const dlgBg=await page.evaluate(()=>{const d=document.querySelector('[role=dialog]')||document.body;return getComputedStyle(d).backgroundColor;});
 r.dialogBg=dlgBg;
 r.input=await styleOf(page,'[data-pc] input');r.label=await styleOf(page,'[data-pc] label');
 r.primary=await styleOf(page,'[data-pc] form button.primary');r.secondary=await styleOf(page,'[data-pc] form button.secondary');
 await page.screenshot({path:`${OUT}/light-${lang}-cancel.png`});
 const pairs={};if(r.noticeP&&r.dialogBg)pairs.notice=cr(r.noticeP.color,r.dialogBg);if(r.input)pairs.input=cr(r.input.color,r.input.bg);if(r.primary)pairs.primary=cr(r.primary.color,r.primary.bg);if(r.secondary)pairs.secondary=cr(r.secondary.color,r.secondary.bg);r.contrast=pairs;
 out[lang]=r;
 // classes calendar
 await page.keyboard.press('Escape');await sleep(300);await page.evaluate(()=>{document.querySelectorAll('[role=dialog] button').forEach(b=>{if(/✕|إغلاق|Close/.test(b.innerText+b.getAttribute('aria-label')))b.click();});});await sleep(300);
 out[lang].classes=await clickText(page,'^(الحصص والحجوزات|Classes & bookings)$');await sleep(1200);
 for(const w of [1440,1010]){await page.setViewport({width:w,height:1000});await sleep(500);const m=await page.evaluate(()=>{const c=document.querySelector('.class-calendar');if(!c)return null;const cs=getComputedStyle(c);return {cols:cs.gridTemplateColumns.split(' ').length,overflowX:cs.overflowX,scrollW:c.scrollWidth,clientW:c.clientWidth,docOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,day0bg:getComputedStyle(c.querySelector('.calendar-day')||c).backgroundColor,txt:getComputedStyle(c.querySelector('.calendar-day')||c).color};});out[lang]['cal'+w]=m;const cal=await page.$('.class-calendar');if(cal){await cal.evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:`${OUT}/light-${lang}-cal-${w}.png`});}}
 await page.close();}
await browser.close();server.close();console.log(JSON.stringify(out,null,1));
