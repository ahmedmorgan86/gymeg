// Optional real-browser check (not in the runner: needs /tmp/harness with esbuild + puppeteer-core, and Chrome).
// Run: node --experimental-strip-types --import ./tests/workspace-post-loader.mjs tests/member-console.browser.mjs
// Renders the REAL MemberConsole twice (flags OFF = legacy, ON = candidates + detail + paged history) against the REAL routes over PGlite and compares what the user sees.
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
const bundle=async on=>(await esbuild.build({stdin:{contents:`import {createRoot} from 'react-dom/client';import React from 'react';import C,{MemberConsoleDetails} from './app/member-console.tsx';const p=window.__P;createRoot(document.getElementById('r')).render(React.createElement(C,{...p,mutate:async()=>true,reload:async()=>{}}));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.tsx':'tsx','.ts':'ts','.css':'local-css'},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES':on?'"1"':'"0"','process.env.NEXT_PUBLIC_GYMOS_MEMBER_HISTORY':'"0"'},alias:{'next/image':'/tmp/gymeg/tests/browser-img-stub.tsx'},external:[],outdir:'/tmp/hout'})).outputFiles;
const pick=(fs,ext)=>fs.filter(f=>f.path.endsWith(ext)).map(f=>f.text).join('\n');const bo={on:await bundle(true),off:await bundle(false)};const js={on:pick(bo.on,'.js'),off:pick(bo.off,'.js')},css={on:pick(bo.on,'.css'),off:pick(bo.off,'.css')};
const calls=[];
const props=JSON.stringify({state:{...s,events:[],receipts:[]},branch,owner:'t-A',actor:'staff',role,busy:false,serverNow,ar:false});
const server=http.createServer(async(rq,rs)=>{
 if(/^\/api\/workspace\/(member-candidates|member-detail|member-history)/.test(rq.url)){calls.push(rq.url);const h=rq.url.includes('member-candidates')?cand:rq.url.includes('member-detail')?det:hist;const r=await h.GET(new Request('https://example.test'+rq.url,{headers:{'X-GymOS-Tenant':rq.headers['x-gymos-tenant']??''}}));rs.writeHead(r.status,{'content-type':'application/json'});return rs.end(await r.text());}
 if(rq.url.startsWith('/app-')){rs.writeHead(200,{'content-type':'text/javascript'});return rs.end(js[rq.url.slice(5,rq.url.indexOf('.'))]);}
 rs.writeHead(200,{'content-type':'text/html'});const mode=rq.url.includes('on')?'on':'off';rs.end(`<!doctype html><meta charset=utf-8><style>${css[mode]}</style><script>window.process={env:{}}</script><div id=r></div><script>window.__P=${props.replace(/</g,'\\u003c')}</script><script src="/app-${mode}.js"></script>`);});
await new Promise(r=>server.listen(0,r));const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu'],headless:'new'});
let ok=true;const check=(c,msg)=>{console.log(c?'PASS':'FAIL',msg);if(!c)ok=false;};
const run=async mode=>{
 const page=await browser.newPage();await page.setViewport({width:1280,height:900});page.on('pageerror',x=>console.log('pageerror:',String(x.stack??x).slice(0,1500)));
 calls.length=0;await page.goto(`http://localhost:${port}/${mode}`);
 await page.waitForSelector('tbody tr',{timeout:10000});await new Promise(r=>setTimeout(r,1500));
 const out={calls:[...calls]};
 out.rows=await page.$$eval('tbody tr',e=>e.map(x=>x.innerText.replace(/\s+/g,' ').trim()));
 out.metrics=await page.$eval('body',b=>[...b.querySelectorAll('[aria-label="Member summary"] *')].map(x=>x.children.length?'':x.textContent).filter(Boolean).join('|'));
 await page.screenshot({path:`/downloads/member-console-list-${mode}.png`});
 // open the member with the longest history
 const name=big.name;const rowIdx=out.rows.findIndex(r=>r.includes(name));
 const btns=await page.$$('tbody tr');const b=await btns[rowIdx].$('button');await b.click();await new Promise(r=>setTimeout(r,1200));
 out.callsAfterOpen=[...calls];
 out.detail=await page.evaluate(()=>{const d=document.querySelector('[class*="details"]');return d?d.innerText.replace(/\s+/g,' ').trim():null;});
 await page.screenshot({path:`/downloads/member-console-detail-${mode}.png`});
 // attendance tab
 const tab=(await page.$$('nav button')).find?null:null;
 const clicked=await page.evaluate(()=>{const b=[...document.querySelectorAll('nav button')].find(x=>/Attendance/.test(x.textContent));if(b){b.click();return true;}return false;});
 await new Promise(r=>setTimeout(r,800));
 for(let i=0;i<10;i++){const more=await page.evaluateHandle(()=>[...document.querySelectorAll('button')].find(x=>/Show older/.test(x.textContent)));if(!more.asElement())break;await more.asElement().click();await new Promise(r=>setTimeout(r,500));}
 out.visits=await page.evaluate(()=>[...document.querySelectorAll('article')].map(x=>x.innerText.replace(/\s+/g,' ').trim()).filter(x=>/Check-in/.test(x)));
 out.clicked=clicked;out.callsAfterVisits=[...calls];
 await page.screenshot({path:`/downloads/member-console-visits-${mode}.png`});
 await page.close();return out;};
try{
 const off=await run('off'),on=await run('on');
 check(off.calls.length===0,'OFF makes no new-route requests');
 check(on.calls.some(c=>c.includes('member-candidates')),'ON fetches candidates: '+on.calls.filter(c=>c.includes('member-candidates')).length);
 check(JSON.stringify(on.rows)===JSON.stringify(off.rows),`list rows identical OFF vs ON (${off.rows.length} rows)`);if(JSON.stringify(on.rows)!==JSON.stringify(off.rows)){const i=off.rows.findIndex((r,k)=>r!==on.rows[k]);console.log('first diff',i,'\nOFF:',off.rows[i],'\nON: ',on.rows[i]);}
 check(on.metrics===off.metrics,'metric tiles identical');
 check(on.callsAfterOpen.some(c=>c.includes('member-detail')),'ON opens detail through member-detail');
 check(on.detail&&on.detail===off.detail,'detail panel text identical');if(on.detail!==off.detail){console.log('OFF:',off.detail?.slice(0,700));console.log('ON: ',on.detail?.slice(0,700));}
 check(on.visits.length===off.visits.length&&on.visits.every((v,i)=>v===off.visits[i]),`attendance list identical in legacy order (${off.visits.length} rows, ON paged: ${on.callsAfterVisits.filter(c=>c.includes('member-history')).length} requests)`);
 console.log('ON requests:',on.callsAfterVisits.map(c=>c.split('?')[0].split('/').pop()+(c.includes('before')?'+before':'')).join(','));
}finally{await browser.close();server.close();}
console.log(ok?'ALL PASS':'FAILURES');process.exit(ok?0:1);
