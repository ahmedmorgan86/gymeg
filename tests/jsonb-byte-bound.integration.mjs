// Byte-bound argument, executable part.
// Claim (stored form): for any jsonb value S in the table, however it got there (app write, direct SQL, import, restore),
//   octet_length(S::text) >= utf8 bytes of JSON.stringify(JSON.parse(S::text)), i.e. of what assembly re-serializes.
// Claim (JS form): for every value V that JSON.stringify produces from a JS value and that Postgres jsonb accepts,
//   octet_length(V::jsonb::text) >= utf8 bytes of JSON.stringify(parsed V).
// Why: (1) jsonb::text adds one space after each ':' and ',' and never removes bytes; key order and duplicate-key
// collapse do not change size for JS-produced objects. (2) numbers: JS prints the shortest round-trip form; jsonb prints the
// exact numeric, which is never shorter (exponent forms expand to digits). (3) strings: both escape only quote, backslash and
// control characters, both emit non-ASCII as raw UTF-8; lone surrogates and U+0000 are rejected by jsonb at write time (the write fails; nothing is undercounted).
// This test fuzzes those classes against real jsonb. It proves the per-row bound only; the assembled-state arithmetic
// (collection keys, commas, photo wrapper) is covered by meta + rows + 4096 + 9 per photo and checked in entity-counters/hot-size tests.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=await bootstrapDb();
const bytes=s=>new TextEncoder().encode(s).byteLength;
const cases=[0,-0,1,-1,0.1,0.1+0.2,1e21,1e-7,1.5e300,5e-324,Number.MAX_SAFE_INTEGER,Number.MAX_VALUE,-1.7976931348623157e308,123456789.123456789,
 '', 'a', '\u0001\u001f\u007f', '"\\/', '\u2028\u2029', 'é', '€', '😀', '\ufeff', 'x'.repeat(10000), '😀'.repeat(5000), '\n\t\r\b\f',
 true,false,null,[],{}, [[],[[]],{}], {'':''}, {'é':1,'😀':2,'"':3,'\\':4,'\n':5}, {a:{b:{c:[1,2,{d:'e'}]}}}, Array.from({length:500},(_,i)=>i*1.1),
 {at:'2026-01-01T00:00:00.'+'0'.repeat(200000)+'Z'}, {k:'\u0000'.length}];
test('jsonb text size is never below compact JSON bytes',async()=>{
  for(const v of cases){const j=JSON.stringify(v);const r=await db.query('SELECT octet_length($1::jsonb::text) AS n',[j]);
    assert.ok(Number(r.rows[0].n)>=bytes(j),`${j.slice(0,60)}: ${r.rows[0].n} < ${bytes(j)}`);}
});
test('stored-form dominance: parse and re-stringify of the stored jsonb text',async()=>{
  const raw=['{"a":1.0}','{"a":1e400}','{"a":1.50}','[1E2,0.000001e-3]','{"b":1,"a":2,"a":3}','{ "x" : [ 1 , 2 ] }','"\\u00e9\\u2028"','{"n":-0}','{"n":12345678901234567890123}','{"k":"\\ud83d\\ude00"}'];
  for(const j of raw){const r=await db.query('SELECT $1::jsonb::text AS s',[j]);const s=r.rows[0].s;
    let reser;try{reser=JSON.stringify(JSON.parse(s));}catch{continue;}
    assert.ok(bytes(s)>=bytes(reser),`${j}: stored ${bytes(s)} < reserialized ${bytes(reser)}`);}
});
test('random fuzz of nested values',async()=>{
  let seed=12345;const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
  const str=()=>{const pool=['a','"','\\','\n','\u0001','é','€','😀','/',' ','\u007f','\u2028'];let s='';for(let i=0,n=Math.floor(rnd()*12);i<n;i++)s+=pool[Math.floor(rnd()*pool.length)];return s;};
  const num=()=>[0,1,-1,rnd()*1e6,rnd()*1e-9,rnd()*1e30,Math.floor(rnd()*2**53)][Math.floor(rnd()*7)];
  const gen=d=>{const t=Math.floor(rnd()*(d>3?4:6));return t===0?str():t===1?num():t===2?rnd()<.5:t===3?null:t===4?Array.from({length:Math.floor(rnd()*4)},()=>gen(d+1)):Object.fromEntries(Array.from({length:Math.floor(rnd()*4)},()=>[str(),gen(d+1)]));};
  for(let i=0;i<1500;i++){const j=JSON.stringify(gen(0));const r=await db.query('SELECT octet_length($1::jsonb::text) AS n',[j]);assert.ok(Number(r.rows[0].n)>=bytes(j),j.slice(0,80));}
});
test('jsonb rejects what would be uncountable (lone surrogate, NUL escape)',async()=>{
  await assert.rejects(()=>db.query("SELECT $1::jsonb",[JSON.stringify('\ud800')]));
  await assert.rejects(()=>db.query("SELECT $1::jsonb",['"\\u0000"']));
});
