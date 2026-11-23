import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {assignKey,renumber,compareNames,probes}=await import('../app/lib/name-order.ts');
import {readFileSync} from 'node:fs';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/name-corpus.json',import.meta.url)));
const store=items=>({
  atOrBelow:async(k,ex)=>{let b=null;for(const x of items.values())if(x.id!==ex&&x.key<=k&&(!b||x.key>b.key))b=x;return b;},
  above:async(k,ex)=>{let b=null;for(const x of items.values())if(x.id!==ex&&x.key>k&&(!b||x.key<b.key))b=x;return b;},
});
let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
test('maintained name key keeps (ar comparator, position) order across inserts, renames, deletes, ties and renumbers',async()=>{
  const items=new Map();let pos=0,renumbers=0;probes.n=0;let writes=0,maxProbe=0;
  const place=async it=>{const before=probes.n;let k=await assignKey(store(items),it);if(k===null){renumbers++;items.set(it.id,{...it,key:Number.NaN});const m=renumber([...items.values()]);for(const [id,key] of m)items.get(id).key=key;}else items.set(it.id,{...it,key:k});writes++;maxProbe=Math.max(maxProbe,probes.n-before);};
  const check=()=>{const byKey=[...items.values()].sort((a,b)=>a.key-b.key).map(x=>x.id);const byCmp=[...items.values()].sort(compareNames).map(x=>x.id);assert.deepEqual(byKey,byCmp);assert.equal(new Set([...items.values()].map(x=>x.key)).size,items.size,'keys are distinct');};
  for(let i=0;i<1500;i++){
    const r=rnd(),ids=[...items.keys()];
    if(r<0.6||ids.length<5){const id='m'+i;await place({id,name:corpus[Math.floor(rnd()*corpus.length)],position:pos++});}
    else if(r<0.85){const id=ids[Math.floor(rnd()*ids.length)];const cur=items.get(id);await place({id,name:corpus[Math.floor(rnd()*corpus.length)],position:cur.position});}
    else items.delete(ids[Math.floor(rnd()*ids.length)]);
    if(i%50===0)check();
  }
  check();
  // worst case for gap exhaustion: many inserts at the same spot
  for(let i=0;i<120;i++)await place({id:'z'+i,name:'محمد',position:pos++});check();
  console.log('NAME-ORDER writes',writes,'renumbers',renumbers,'max probes per write',maxProbe,'members',items.size);
  assert.ok(maxProbe<=70);
});
