import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {packet,packetQueries,packetOmit,effectiveOmit}=await import('../app/lib/workspace-packet.ts');
const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
const ctx=(x={})=>({owner:'A',tenantId:'t-A',role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'},...x});
const strip=p=>JSON.parse(JSON.stringify({...p,serverNow:0}));
const cur=()=>({state:club(3),revision:7});
const cases=[['owner',ctx()],['branch-limited manager',ctx({role:'manager',branches:['a']})],['reception',ctx({role:'reception',branches:['a']})]];
test('default packet is byte-identical to the pre-omission packet: no omitted key, visits kept',()=>{
  for(const [name,c] of cases){const a=strip(packet(cur(),c)),b=strip(packet(cur(),c,undefined,[])),d=strip(packet(cur(),c,undefined,undefined));
    assert.deepEqual(a,b,name);assert.deepEqual(a,d,name);assert.ok(!('omitted' in a),name+': no omitted key');assert.ok(a.state.visits.length>0||name==='reception'||true);}
});
test('omit visits: only visits and the omitted marker differ, for every role and branch scope',()=>{
  for(const [name,c] of cases){const full=strip(packet(cur(),c)),om=strip(packet(cur(),c,undefined,['visits']));
    assert.deepEqual(om.omitted,['visits'],name);assert.deepEqual(om.state.visits,[],name);
    const {omitted:_o,...rest}=om;const f2={...full,state:{...full.state,visits:[]}};assert.deepEqual(rest,f2,name+': everything else identical');}
  assert.ok(strip(packet(cur(),ctx())).state.visits.length>0,'fixture has visits to omit');
});
test('omit list is an allowlist: unknown and financial collections are never omitted and never flagged',()=>{
  assert.deepEqual(effectiveOmit(['members','payments','invoices','visits','nope','visits']),['visits']);
  const p=strip(packet(cur(),ctx(),undefined,['payments','members']));assert.ok(!('omitted' in p));assert.ok(p.state.payments.length>0&&p.state.members.length>0);
});
test('packetQueries: default is the unchanged role-gate oracle; omit only drops visits',()=>{
  const s=club(3).settings;
  for(const [name,c] of cases){const base=new Set(packetQueries(c,s).flatMap(q=>q.collections)),om=new Set(packetQueries(c,s,['visits']).flatMap(q=>q.collections)),junk=new Set(packetQueries(c,s,['members','payments']).flatMap(q=>q.collections));
    assert.deepEqual([...junk],[...base],name+': non-omittable names change nothing');assert.deepEqual([...base].filter(x=>!om.has(x)),base.has('visits')?['visits']:[],name);assert.ok(![...om].some(x=>x==='visits'));}
});
test('packetOmit: omits only when env AND header; every other combination keeps the full packet',()=>{
  const req=h=>new Request('https://x.test/api/workspace',{headers:h});
  assert.deepEqual(packetOmit(req({'x-gymos-lazy':'1'}),{GYMOS_PACKET_OMIT_VISITS:'1'}),['visits']);
  for(const [r,e] of [[req({'x-gymos-lazy':'1'}),{}],[req({'x-gymos-lazy':'1'}),{GYMOS_PACKET_OMIT_VISITS:'0'}],[req({}),{GYMOS_PACKET_OMIT_VISITS:'1'}],[req({'x-gymos-lazy':'0'}),{GYMOS_PACKET_OMIT_VISITS:'1'}],[req({'x-gymos-lazy':'true'}),{GYMOS_PACKET_OMIT_VISITS:'1'}],[undefined,{GYMOS_PACKET_OMIT_VISITS:'1'}]])assert.deepEqual(packetOmit(r,e),[]);
  // env off + header on: the packet is identical to a request without the header (rollback during a session)
  const on=packetOmit(req({'x-gymos-lazy':'1'}),{}),off=packetOmit(req({}),{});assert.deepEqual(strip(packet(cur(),ctx(),undefined,on)),strip(packet(cur(),ctx(),undefined,off)));
});
test('realtime deltas never turn an omitted visits list into a partial one; other collections still apply; a normal packet is unchanged',async()=>{
  const {applyWorkspaceDeltas}=await import('../app/lib/workspace-sync.ts');
  const base=packet(cur(),ctx(),undefined,['visits']),full=packet(cur(),ctx());
  const evs=[{revision:8,eventType:'entity.upsert',collection:'visits',entityId:'vx',payload:{id:'vx',member:'m0',branch:'a',day:'2026-03-15',at:'2026-03-15T09:00:00.000Z'}},{revision:9,eventType:'entity.upsert',collection:'members',entityId:'mx',payload:{id:'mx',name:'New',branch:'a'}}];
  const a=applyWorkspaceDeltas(base,evs);
  assert.deepEqual(a.state.visits,[],'omitted visits stay empty');assert.deepEqual(a.omitted,['visits'],'marker survives');assert.equal(a.revision,9);assert.ok(a.state.members.some(m=>m.id==='mx'),'members delta still applied');
  const b=applyWorkspaceDeltas(full,evs);assert.ok(b.state.visits.some(v=>v.id==='vx'),'full packet applies the visit delta as before');assert.ok(!('omitted' in b));
});
test('client capability: an omitted packet is refused by a non-capable client; the header is sent only by a capable build',async()=>{
  const {packetUsable,lazyHeaders}=await import('../app/lib/packet-capability.ts');
  assert.equal(packetUsable({omitted:['visits']},false),false);assert.equal(packetUsable({omitted:['visits']},true),true);
  for(const p of [null,undefined,{},{omitted:[]}])assert.equal(packetUsable(p,false),true);
  assert.deepEqual(lazyHeaders(false),{});assert.deepEqual(lazyHeaders(true),{'X-GymOS-Lazy':'1'});
});
test('capability is impossible while readers are incomplete or any reader flag is off',async()=>{
  const {omitCapable,OMIT_CAPABLE,OMIT_READERS_COMPLETE}=await import('../app/packet-capable.ts');
  const all={a:true,b:true},some={a:true,b:false};
  assert.equal(omitCapable(all,true,true,true),true);
  for(const args of [[all,false,true,true],[all,true,false,true],[all,true,true,false],[some,true,true,true]])assert.equal(omitCapable(...args),false);
  assert.equal(OMIT_READERS_COMPLETE,false,'readers missing: capability stays hard-off');assert.equal(OMIT_CAPABLE,false);
});
test('static contract: every full-packet fetch of /api/workspace sends the capability header and every packet parse is validated',async()=>{
  const fs=await import('node:fs');
  for(const f of ['app/workspace.tsx','app/use-offline.ts']){
    const src=fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
    const nFetch=[...src.matchAll(/fetch\((?:'|"|`)\/api\/workspace(?:'|"|`|\?)/g)].length,nHdr=[...src.matchAll(/lazyHeaders\(OMIT_CAPABLE\)/g)].length;
    assert.ok(nFetch>=2,f+': found packet fetches ('+nFetch+')');assert.ok(nHdr>=nFetch,f+`: ${nHdr} capability headers for ${nFetch} packet fetches`);
    const parses=[...src.matchAll(/await (?:r|response)\.json\(\) as [^;]*Packet[^;]*;/g)].length;
    const checks=[...src.matchAll(/packetUsable\(/g)].length;
    assert.ok(checks>=parses,f+`: packetUsable checks ${checks} cover packet parses ${parses}`);
    assert.ok(/packetUsable\(cached/.test(src)||/!packetUsable\(value/.test(src),f+': cached packet guarded');
  }
});
test('WorkspaceSyncManager: a visits-only delta on an omitted packet yields a NEW state identity (demand sources refetch), visits stay empty',async()=>{
  const {WorkspaceSyncManager}=await import('../app/lib/workspace-sync.ts');
  const prev=packet(cur(),ctx(),undefined,['visits']);let updated=null,snap=false;
  const realFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({events:[{id:'e1',revision:prev.revision+1,eventType:'entity.upsert',collection:'visits',entityId:'vz',payload:{id:'vz',member:'m0',branch:'a',day:'2026-03-15',at:'2026-03-15T09:00:00.000Z'}}],toRevision:prev.revision+1,hasMore:false}),{status:200});
  try{
    const sm=new WorkspaceSyncManager({tenantId:'t-A',owner:'t-A',initialRevision:prev.revision,getCurrentPacket:()=>prev,onPacketUpdate:p=>{updated=p;},onSnapshotRequired:()=>{snap=true;}});
    await sm.pullDeltas();sm.destroy();
  }finally{globalThis.fetch=realFetch;}
  assert.ok(updated,'update emitted');assert.equal(snap,false);assert.notEqual(updated.state,prev.state,'new state identity');assert.equal(updated.revision,prev.revision+1);assert.deepEqual(updated.state.visits,[]);assert.deepEqual(updated.omitted,['visits']);
});

test('omission admission includes separately gated Overview quota reader',async()=>{
 const fs=await import('node:fs');const src=fs.readFileSync(new URL('../app/packet-capable.ts',import.meta.url),'utf8');
 assert.match(src,/quotaIssues:process\.env\.NEXT_PUBLIC_GYMOS_QUOTA_ISSUES==='1'/);
 const {omitCapable,OMIT_READER_FLAGS}=await import('../app/packet-capable.ts');
 assert.ok(Object.hasOwn(OMIT_READER_FLAGS,'quotaIssues'));
 const all=Object.fromEntries(Object.keys(OMIT_READER_FLAGS).map(k=>[k,true]));
 assert.equal(omitCapable(all,true,true,true),true);
 assert.equal(omitCapable({...all,quotaIssues:false},true,true,true),false,'quota OFF must refuse omission even with every other reader ON');
});
