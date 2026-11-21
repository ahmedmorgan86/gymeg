// Optional check (not in the runner: needs a local Chrome). Compares the browser's localeCompare('ar') order with Node's on the name corpus.
import {execFileSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const chrome=process.env.CHROME_BIN||'google-chrome';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/name-corpus.json',import.meta.url)));
const dir=mkdtempSync(join(tmpdir(),'coll-'));const page=join(dir,'p.html');
writeFileSync(page,`<meta charset=utf-8><pre id=o></pre><script>const c=${JSON.stringify(corpus)};document.getElementById('o').textContent=JSON.stringify([...c].sort((a,b)=>a.localeCompare(b,'ar')));</script>`);
let dom;try{dom=execFileSync(chrome,['--headless=new','--no-sandbox','--disable-gpu','--dump-dom','file://'+page],{encoding:'utf8',timeout:40000,stdio:['ignore','pipe','ignore']});}catch{console.log('SKIP: no usable Chrome');process.exit(0);}
const m=/<pre id="o">([\s\S]*?)<\/pre>/.exec(dom);const un=s=>s.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'");
const browser=JSON.parse(un(m[1])),node=[...corpus].sort((a,b)=>a.localeCompare(b,'ar'));
const bad=node.map((x,i)=>x===browser[i]?null:i).filter(i=>i!==null);
console.log('browser vs node order:',bad.length===0?`identical on ${corpus.length} names`:`DIFFERS at ${bad.length} positions, first ${bad[0]}`);process.exit(bad.length?1:0);
