// Evidence, not a test: JS heap bytes per serialized JSON byte for parsed visit rows (run with node --expose-gc). Shape-dependent; not a general constant.
const mk=g=>({position:g,entity_id:'v'+g,payload:{id:'v'+g,member:'m'+(g%10000),branch:'a',day:'2026-03-0'+(g%9),at:'2026-03-01T10:00:00.000Z',leftAt:'2026-03-01T11:00:00.000Z'}});
global.gc&&gc();const h0=process.memoryUsage().heapUsed;
const rows=[];for(let g=0;g<100000;g++){rows.push(JSON.parse(JSON.stringify(mk(g))));}
global.gc&&gc();const h1=process.memoryUsage().heapUsed;
const bytes=rows.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r.payload)),0);
const sorted=rows.slice().sort((a,b)=>a.position-b.position);global.gc&&gc();const h2=process.memoryUsage().heapUsed;
console.log({rows:rows.length,serializedBytes:bytes,heapBytes:h1-h0,heapPerSerialized:+((h1-h0)/bytes).toFixed(2),extraAfterSortCopy:h2-h1});
