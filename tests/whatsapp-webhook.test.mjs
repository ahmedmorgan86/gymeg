import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {register} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';

// App imports are extensionless for the bundler; resolve them to the .ts files
// that Node type-stripping loads so the real route handlers can be exercised.
register('data:text/javascript,'+encodeURIComponent(`
export async function resolve(specifier,context,nextResolve){
  if(specifier==='server-only')return {url:'data:text/javascript,export%20default%20%7B%7D;',shortCircuit:true};
  if(specifier==='next/headers')return {url:'data:text/javascript,export%20function%20cookies()%7Breturn%7Bget%3A()%3D%3Eundefined%2Cset%3A()%3D%3E%7B%7D%7D%3B%7D',shortCircuit:true};
  if(specifier==='next/navigation')return {url:'data:text/javascript,export%20function%20redirect()%7B%7D',shortCircuit:true};
  try{return await nextResolve(specifier,context);}catch(error){
    if(error.code==='ERR_MODULE_NOT_FOUND'&&(specifier.startsWith('./')||specifier.startsWith('../')))
      return nextResolve(specifier+'.ts',context);
    throw error;
  }
}
`));
const {GET,POST}=await import('../app/api/whatsapp/webhook/route.ts');
const {consumeWhatsAppWebhook,whatsappPhoneDigest}=await import('../app/lib/whatsapp-server.ts');

const VERIFY_TOKEN='verify_'+'a'.repeat(32);
const APP_SECRET='app-secret-'+'b'.repeat(32);
const WEBHOOK_URL='https://gymeg.test/api/whatsapp/webhook';
const routeSource=readFileSync(new URL('../app/api/whatsapp/webhook/route.ts',import.meta.url),'utf8');
const serverSource=readFileSync(new URL('../app/lib/whatsapp-server.ts',import.meta.url),'utf8');
const signed=(secret,body)=>'sha256='+createHmac('sha256',secret).update(body).digest('hex');
const post=(body,signature)=>new Request(WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json',...(signature?{'x-hub-signature-256':signature}:{})},body});
const stopPayload=(id,text,phoneId='555111')=>({object:'whatsapp_business_account',entry:[{id:'entry-1',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:phoneId},messages:[{id,from:'201012345678',timestamp:'1763364000',type:'text',text:{body:text}}]}}]}]});
const statusPayload=(id,status)=>({object:'whatsapp_business_account',entry:[{id:'entry-1',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'555111'},statuses:[{id,status,recipient_id:'201012345678',timestamp:'1763364000'}]}}]}]});
const queryFor=db=>async(sql,params)=>({rows:(await db.query(sql,params)).rows});

test('GET verification uses a server-only token, compares in constant time and echoes only the challenge',async()=>{
  const previous=process.env.GYMEG_WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  process.env.GYMEG_WHATSAPP_WEBHOOK_VERIFY_TOKEN=VERIFY_TOKEN;
  try{
    const ok=await GET(new Request(WEBHOOK_URL+'?hub.mode=subscribe&hub.challenge=123456789&hub.verify_token='+encodeURIComponent(VERIFY_TOKEN)));
    assert.equal(ok.status,200);
    assert.equal(await ok.text(),'123456789');
    assert.equal((await GET(new Request(WEBHOOK_URL+'?hub.mode=subscribe&hub.challenge=123456789&hub.verify_token=wrong'))).status,403);
    assert.equal((await GET(new Request(WEBHOOK_URL+'?hub.mode=bad&hub.challenge=123456789&hub.verify_token='+encodeURIComponent(VERIFY_TOKEN)))).status,400);
    assert.equal((await GET(new Request(WEBHOOK_URL+'?hub.mode=subscribe&hub.verify_token='+encodeURIComponent(VERIFY_TOKEN)))).status,400);
    assert.match(serverSource,/process\.env\.GYMEG_WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
    assert.doesNotMatch(routeSource,/NEXT_PUBLIC_/);
    assert.doesNotMatch(serverSource,/NEXT_PUBLIC_/);
  }finally{
    if(previous===undefined)delete process.env.GYMEG_WHATSAPP_WEBHOOK_VERIFY_TOKEN;else process.env.GYMEG_WHATSAPP_WEBHOOK_VERIFY_TOKEN=previous;
  }
});

test('POST rejects missing, malformed, forged and body-tampered signatures before parsing',async()=>{
  const previous=process.env.GYMEG_WHATSAPP_APP_SECRET;
  process.env.GYMEG_WHATSAPP_APP_SECRET=APP_SECRET;
  try{
    const body=JSON.stringify({object:'whatsapp_business_account',entry:[]});
    assert.equal((await POST(post(body,null))).status,401);
    assert.equal((await POST(post(body,'sha256=abc'))).status,400);
    assert.equal((await POST(post(body,signed('wrong-secret',body)))).status,403);
    assert.equal((await POST(post(body+' ',signed(APP_SECRET,body)))).status,403);
  }finally{
    if(previous===undefined)delete process.env.GYMEG_WHATSAPP_APP_SECRET;else process.env.GYMEG_WHATSAPP_APP_SECRET=previous;
  }
});

test('Accepted webhook ack and logs contain no raw secret, token or payload',async()=>{
  const previousSecret=process.env.GYMEG_WHATSAPP_APP_SECRET;
  const previousMock=process.env.GYMOS_ALLOW_DB_MOCK;
  process.env.GYMEG_WHATSAPP_APP_SECRET=APP_SECRET;
  process.env.GYMOS_ALLOW_DB_MOCK='1';
  const lines=[],original={log:console.log,info:console.info,warn:console.warn,error:console.error};
  console.log=console.info=console.warn=console.error=(...args)=>{lines.push(args.map(String).join(' '));};
  try{
    const body=JSON.stringify({object:'whatsapp_business_account',entry:[]});
    const response=await POST(post(body,signed(APP_SECRET,body)));
    assert.equal(response.status,200);
    const text=await response.text();
    assert.ok(!text.includes(APP_SECRET));
    assert.ok(!text.includes(VERIFY_TOKEN));
    assert.ok(!text.includes(body));
    assert.ok(lines.every(line=>!line.includes(APP_SECRET)&&!line.includes(VERIFY_TOKEN)));
    assert.doesNotMatch(routeSource,/console\./);
    assert.doesNotMatch(serverSource,/console\./);
  }finally{
    Object.assign(console,original);
    if(previousSecret===undefined)delete process.env.GYMEG_WHATSAPP_APP_SECRET;else process.env.GYMEG_WHATSAPP_APP_SECRET=previousSecret;
    if(previousMock===undefined)delete process.env.GYMOS_ALLOW_DB_MOCK;else process.env.GYMOS_ALLOW_DB_MOCK=previousMock;
  }
});

test('STOP is stored as a phone digest for every linked owner and redelivery is idempotent',async()=>{
  const db=await bootstrapDb({through:'20261117138000_whatsapp_webhook_consent.sql'});
  try{
    await db.query("INSERT INTO gymos.gym_states(user_id,payload,updated_at) VALUES('owner-a','{}','2026-11-17'),('owner-b','{}','2026-11-17')");
    await db.query("INSERT INTO gymos.whatsapp_connections(owner_id,branch,phone_id,token_cipher,api_version) VALUES('owner-a','main','555111','cipher','v23.0'),('owner-b','main','555111','cipher','v23.0')");
    const query=queryFor(db),digest=whatsappPhoneDigest('+201012345678');
    assert.match(digest,/^[a-f0-9]{64}$/);
    assert.match(serverSource,/gymos\.whatsapp_opted_out/);
    assert.match(serverSource,/optedOut\|\|/);
    const payload=stopPayload('wamid.stop.1','  sToP  ');
    assert.deepEqual(await consumeWhatsAppWebhook(payload,query),{optouts:1,statuses:0,duplicates:0,ignored:0});
    const rows=(await db.query('SELECT owner_id,phone_hash FROM gymos.whatsapp_optouts ORDER BY owner_id')).rows;
    assert.deepEqual(rows.map(row=>row.owner_id),['owner-a','owner-b']);
    assert.ok(rows.every(row=>row.phone_hash===digest));
    assert.ok(!JSON.stringify(rows).includes('201012345678'));
    assert.deepEqual(await consumeWhatsAppWebhook(payload,query),{optouts:0,statuses:0,duplicates:1,ignored:0});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gymos.whatsapp_optouts')).rows[0].n,2);
    await consumeWhatsAppWebhook(stopPayload('wamid.stop.2','UNSUBSCRIBE','999999'),query);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gymos.whatsapp_optouts WHERE owner_id='*'")).rows[0].n,1);
    assert.equal((await db.query('SELECT gymos.whatsapp_opted_out($1,$2) AS out',['owner-z',digest])).rows[0].out,true);
  }finally{await db.close();}
});

test('Delivery statuses persist once per provider message/status without overwriting send acceptance',async()=>{
  const db=await bootstrapDb({through:'20261117138000_whatsapp_webhook_consent.sql'});
  try{
    await db.query("INSERT INTO gymos.gym_states(user_id,payload,updated_at) VALUES('owner-a','{}','2026-11-17')");
    await db.query("INSERT INTO gymos.whatsapp_outbox(owner_id,id,branch,member_id,rule_id,occurrence,status,payload,provider_id) VALUES('owner-a','out-1','main','member-1','rule-1','2026-11-17','sent','{}','wamid.del.1')");
    const query=queryFor(db),read=()=>db.query("SELECT status,delivery_status FROM gymos.whatsapp_outbox WHERE provider_id='wamid.del.1'");
    const delivered=statusPayload('wamid.del.1','delivered');
    assert.deepEqual(await consumeWhatsAppWebhook(delivered,query),{optouts:0,statuses:1,duplicates:0,ignored:0});
    assert.equal((await read()).rows[0].delivery_status,'delivered');
    assert.equal((await read()).rows[0].status,'sent');
    assert.deepEqual(await consumeWhatsAppWebhook(delivered,query),{optouts:0,statuses:0,duplicates:1,ignored:0});
    assert.deepEqual(await consumeWhatsAppWebhook(statusPayload('wamid.del.1','read'),query),{optouts:0,statuses:1,duplicates:0,ignored:0});
    assert.equal((await read()).rows[0].delivery_status,'read');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gymos.whatsapp_webhook_events')).rows[0].n,2);
    assert.ok(!JSON.stringify((await db.query('SELECT * FROM gymos.whatsapp_webhook_events')).rows).includes('201012345678'));
  }finally{await db.close();}
});
