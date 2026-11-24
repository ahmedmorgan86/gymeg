import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {statusKey,statusRanks,STATUS_LABELS}=await import('../app/lib/status-rank.ts');
const src=readFileSync(new URL('../app/member-console.tsx',import.meta.url),'utf8');
const line=src.split('\n').find(l=>l.startsWith('function subscriptionLabel'));
test('labels and decision order match the shipped subscriptionLabel source',()=>{
  for(const [a,e] of Object.values(STATUS_LABELS)){assert.ok(line.includes(`t('${a}','${e}')`),a+' / '+e);}
  assert.ok(/x\.remaining<0\?.*x\.status==='warning'\?.*x\.status==='active'\?.*x\.issue==='quota'\?/.test(line),'same decision order');
});
test('rank order equals localeCompare order of the shipped label, with stable ties, in both languages',()=>{
  const combos=[];for(const remaining of [-5,-1,0,1,9])for(const status of ['expired','warning','active'])for(const issue of [null,'quota','inactive','frozen'])combos.push({remaining,status,issue});
  for(const ar of [true,false]){
    const t=(a,e)=>ar?a:e;const label=new Function('t','x',line.slice(line.indexOf('=>string){')+'=>string){'.length).replace(/\}\s*$/,''));
    const rank=statusRanks(ar);
    const items=[];for(let i=0;i<3;i++)for(const c of combos)items.push({...c,pos:items.length});
    const old=[...items].sort((a,b)=>String(label(t,a)).localeCompare(String(label(t,b)),'ar')).map(x=>x.pos);
    const neu=[...items].sort((a,b)=>rank[statusKey(a)]-rank[statusKey(b)]||a.pos-b.pos).map(x=>x.pos);
    assert.deepEqual(neu,old,'ascending '+(ar?'ar':'en'));
    const oldD=[...items].sort((a,b)=>-String(label(t,a)).localeCompare(String(label(t,b)),'ar')).map(x=>x.pos);
    const neuD=[...items].sort((a,b)=>-(rank[statusKey(a)]-rank[statusKey(b)])||a.pos-b.pos).map(x=>x.pos);
    assert.deepEqual(neuD,oldD,'descending '+(ar?'ar':'en'));
    console.log('STATUS-RANK',ar?'ar':'en',JSON.stringify(rank));
  }
});
