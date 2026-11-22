import {getPool} from '../../../lib/database';
import {reply} from '../../../lib/server-workspace';
import {runWhatsApp} from '../../../lib/whatsapp-server';
import {timingSafeEqual} from 'node:crypto';
import {isFirestorePersistence} from '../../../lib/firestore-db';
import {markWhatsAppRun,runWhatsAppFirestore,whatsappOwners} from '../../../lib/firestore-whatsapp';
export const maxDuration=60;
// Vercel Cron sends Authorization: Bearer $CRON_SECRET when CRON_SECRET is set.
// The legacy Supabase pg_cron job (installed disabled) uses a Vault token that
// the database validates; both mechanisms require a secret, and neither is logged.
function secretEquals(presented:string,expected:string){const a=Buffer.from(presented),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}
async function legacyTokenValid(presented:string){
  if(!/^[a-f0-9]{64}$/.test(presented))return false;
  try{return Boolean((await getPool().query('SELECT gymos.messaging_cron_valid($1) AS valid',[presented])).rows[0]?.valid);}catch{return false;}
}
export async function GET(request:Request){
  const actual=request.headers.get('authorization')??'';
  if(!/^Bearer [^\s]{16,}$/.test(actual))return reply({error:'forbidden'},403);
  const presented=actual.slice(7);
  const cronSecret=process.env.CRON_SECRET;
  const authorized=Boolean(cronSecret&&secretEquals(presented,cronSecret))||!isFirestorePersistence()&&await legacyTokenValid(presented);
  if(!authorized)return reply({error:'forbidden'},403);
  if(isFirestorePersistence()){
    let sent=0;const deadline=Date.now()+40000;
    for(const owner of await whatsappOwners()){if(Date.now()>deadline)break;try{sent+=(await runWhatsAppFirestore(owner,undefined,deadline)).sent;await markWhatsAppRun(owner);}catch{/* isolate tenant failures */}}
    return reply({sent});
  }
  const client=await getPool().connect();
  let owners;
  try{await client.query('BEGIN');await client.query("SELECT set_config('app.messaging_worker','1',true)");owners=(await client.query("SELECT owner_id FROM gymos.whatsapp_connections GROUP BY owner_id ORDER BY min(COALESCE(last_run_at,'1970-01-01'::timestamptz)) LIMIT 100")).rows;await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  let sent=0;const deadline=Date.now()+40000;
  for(const row of owners){if(Date.now()>deadline)break;try{sent+=(await runWhatsApp(row.owner_id,undefined,deadline)).sent;await clientUpdate(row.owner_id);}catch{/* isolate tenant failures */}}
  return reply({sent});
}

async function clientUpdate(owner:string){const {withScope}=await import('../../../lib/database');await withScope(owner,c=>c.query('UPDATE gymos.whatsapp_connections SET last_run_at=now() WHERE owner_id=$1',[owner]));}
