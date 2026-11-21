import {codeMemberIdentity} from '../../lib/member-code-session';
import {reply} from '../../lib/server-workspace';
import {withScope} from '../../lib/database';
import {useFirestorePersistence} from '../../lib/firestore-db';
import {normalizeLicense} from '../../lib/commercial';
import {licenseState} from '../../lib/licensing';
import {readOwnMemberAccount} from '../../lib/member-own-account';
export const dynamic='force-dynamic';
/** Member app financial detail only. Browser parameters never select identity. */
export async function GET(request:Request){try{
 if(process.env.GYMOS_MEMBER_ACCOUNT_READS!=='1')return reply({error:'notFound'},404);
 const identity=await codeMemberIdentity(request);if(!identity)return reply({error:'auth'},401);
 if(identity.pin_must_change)return reply({error:'pinChangeRequired'},403);
 if(useFirestorePersistence())return reply({error:'unsupported'},501);
 const license=await withScope(identity.owner_id,async c=>(await c.query('SELECT l.* FROM gymos.tenant_licenses l JOIN gymos.tenants t ON t.id=l.tenant_id WHERE t.storage_key=$1',[identity.owner_id])).rows[0]);
 if(license&&!licenseState(normalizeLicense(license)).writable)return reply({error:'licenseReadOnly'},403);
 const out=await readOwnMemberAccount(withScope,{owner:identity.owner_id,member:identity.member_id,branch:identity.branch});
 if(out.status==='notFound')return reply({error:'notLinked'},404);
 if(out.status!=='ok')return reply(out,503);return reply(out);
 }catch{return reply({status:'unavailable',reason:'read-unavailable'},503);}}
