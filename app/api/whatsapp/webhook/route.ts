import {reply} from '../../../lib/server-workspace';
import {consumeWhatsAppWebhook,verifyWebhookSignature,verifyWebhookToken} from '../../../lib/whatsapp-server';
import {isFirestorePersistence} from '../../../lib/firestore-db';
import {consumeWhatsAppWebhookFirestore} from '../../../lib/firestore-whatsapp';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const MAX_BODY=1000000;

// Meta WhatsApp Cloud webhook verification. The token is server-only and
// compared in constant time; the challenge is echoed, not stored or logged.
export async function GET(request:Request){
  const url=new URL(request.url);
  const mode=url.searchParams.get('hub.mode'),challenge=url.searchParams.get('hub.challenge'),token=url.searchParams.get('hub.verify_token');
  if(mode!=='subscribe'||!challenge||challenge.length>512)return reply({error:'invalid'},400);
  if(!verifyWebhookToken(token))return reply({error:'forbidden'},403);
  return new Response(challenge,{status:200,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'}});
}

// POST verifies X-Hub-Signature-256 over the exact raw bytes before parsing.
// A fast, idempotent ack is returned for every accepted redelivery.
export async function POST(request:Request){
  const secret=process.env.GYMEG_WHATSAPP_APP_SECRET;
  if(!secret)return reply({error:'notConfigured'},503);
  const declared=Number(request.headers.get('content-length')??'0');
  if(Number.isFinite(declared)&&declared>MAX_BODY)return reply({error:'limit'},413);
  const raw=Buffer.from(await request.arrayBuffer());
  if(raw.length>MAX_BODY)return reply({error:'limit'},413);
  const signature=request.headers.get('x-hub-signature-256');
  if(!signature)return reply({error:'signatureMissing'},401);
  if(!/^sha256=[a-f0-9]{64}$/i.test(signature))return reply({error:'signatureInvalid'},400);
  if(!verifyWebhookSignature(raw,signature,secret))return reply({error:'signatureMismatch'},403);
  let payload:unknown;
  try{payload=JSON.parse(raw.toString('utf8'));}catch{return reply({error:'invalid'},400);}
  try{return reply({ok:true,...await (isFirestorePersistence()?consumeWhatsAppWebhookFirestore(payload):consumeWhatsAppWebhook(payload))});}catch{return reply({error:'unavailable'},503);}
}
