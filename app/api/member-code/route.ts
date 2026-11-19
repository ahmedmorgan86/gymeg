import {createHash,randomBytes} from 'node:crypto';
import {syncMemberAccess} from '../../lib/sync-member-access';
import {context,readSpace,reply,sameOrigin} from '../../lib/server-workspace';
import {withScope} from '../../lib/database';
import {assertRequestTenant} from '../../lib/request-tenant';
import {licenseState,CommercialError} from '../../lib/licensing';
import {newMemberPin,normalizeMemberPhone,normalizeMemberPin,isSharedLegacyPin} from '../../lib/member-phone';
import {receptionPermitted} from '../../lib/access';

export async function POST(request:Request){try{
 if(!sameOrigin(request))return reply({error:'origin'},403);
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'invalid'},415);
 const ctx=await context();
 if(!ctx)return reply({error:'auth'},401);
 assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 if(ctx.license&&!licenseState(ctx.license).writable)return reply({error:'licenseReadOnly'},403);
 const raw=await request.text();
 if(raw.length>2048)return reply({error:'invalid'},413);
 const body=JSON.parse(raw),{state}=await readSpace(ctx.owner);
 const hasAccess=['owner','manager'].includes(ctx.role)||
   receptionPermitted(ctx.role,'member.details',state.settings?.receptionGrants?.[ctx.user.userId])||
   receptionPermitted(ctx.role,'member.register',state.settings?.receptionGrants?.[ctx.user.userId]);
 if(!hasAccess)return reply({error:'forbidden'},403);
 const m=state.members.find(m=>m.id===body.member&&!m.demo&&!m.archived);
 if(!m||ctx.branches&&!ctx.branches.includes(m.branch))return reply({error:'forbidden'},403);
 if(!['read','rotate','revoke','requireChange','setPin'].includes(body.action))return reply({error:'invalid'},400);

 const result=await withScope(ctx.owner,async c=>{
  const audit=async(action:string)=>c.query('INSERT INTO gymos.gym_access_events(id,owner_id,actor,target,action,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[crypto.randomUUID(),ctx.owner,ctx.user.userId,m.id,action,JSON.stringify({branch:m.branch})]);
  const existing=(await c.query('SELECT 1 FROM gymos.member_code_access WHERE owner_id=$1 AND member_id=$2',[ctx.owner,m.id])).rowCount;
  if(!existing){
    const normPhone=normalizeMemberPhone(m.phone);
    const phoneDigest=normPhone?createHash('sha256').update(normPhone).digest('hex'):null;
    const code='GM-'+randomBytes(16).toString('hex').toUpperCase();
    const pin=normPhone?newMemberPin():null;
    await c.query("INSERT INTO gymos.member_code_access(owner_id,member_id,branch,code_hash,code_cipher,phone_hash,pin_hash,pin_cipher,pin_must_change,version,revoked,inactive) VALUES($1,$2,$3,encode(extensions.digest($4,'sha256'),'hex'),gymos.member_code_encrypt($4),$5,CASE WHEN $6::text IS NOT NULL THEN gymos.member_pin_hash($6) END,CASE WHEN $6::text IS NOT NULL THEN gymos.member_pin_encrypt($6) END,true,1,false,false) ON CONFLICT(owner_id,member_id) DO UPDATE SET branch=EXCLUDED.branch",[ctx.owner,m.id,m.branch,code,phoneDigest,pin]);
  }
  if(body.action==='requireChange'){
    if(!normalizeMemberPhone(m.phone))return{needsPhone:true};
    const changed=await c.query('UPDATE gymos.member_code_access SET pin_must_change=true,version=version+1 WHERE owner_id=$1 AND member_id=$2 AND NOT revoked AND NOT inactive RETURNING member_id',[ctx.owner,m.id]);
    if(!changed.rowCount)return{revoked:true};
    await c.query('DELETE FROM gymos.member_code_sessions WHERE owner_id=$1 AND member_id=$2',[ctx.owner,m.id]);
    await audit('member.pin.requireChange');
    return{phone:normalizeMemberPhone(m.phone),changeRequired:true,revoked:false};
  }
  if(body.action==='revoke'){
    await c.query('UPDATE gymos.member_code_access SET revoked=true,version=version+1 WHERE owner_id=$1 AND member_id=$2',[ctx.owner,m.id]);
    await c.query('UPDATE gymos.member_portal_access SET revoked=true,invite_hash=NULL WHERE owner_id=$1 AND member_id=$2',[ctx.owner,m.id]);
    await c.query('DELETE FROM gymos.member_code_sessions WHERE owner_id=$1 AND member_id=$2',[ctx.owner,m.id]);
    await audit('member.pin.revoke');
    return{revoked:true};
  }
  if(body.action==='setPin'){
    if(!normalizeMemberPhone(m.phone))return{phone:null,pin:null,needsPhone:true};
    const customPin=normalizeMemberPin(body.pin);
    if(!customPin||isSharedLegacyPin(customPin))return reply({error:'invalidPin'},400);
    await c.query('UPDATE gymos.member_code_access SET pin_hash=gymos.member_pin_hash($1),pin_cipher=gymos.member_pin_encrypt($1),pin_must_change=true,version=version+1,revoked=false WHERE owner_id=$2 AND member_id=$3',[customPin,ctx.owner,m.id]);
    await c.query('DELETE FROM gymos.member_code_sessions WHERE owner_id=$1 AND member_id=$2',[ctx.owner,m.id]);
    await audit('member.pin.set');
    return{phone:normalizeMemberPhone(m.phone),pin:customPin,revoked:false,needsPhone:false,changeRequired:true};
  }
  if(body.action==='rotate'){
    if(!normalizeMemberPhone(m.phone))return{phone:null,pin:null,needsPhone:true};
    const customPin=body.pin?normalizeMemberPin(body.pin):null;
    if(body.pin&&(!customPin||isSharedLegacyPin(customPin)))return reply({error:'invalidPin'},400);
    const currentPin=(await c.query('SELECT gymos.member_code_decrypt(pin_cipher) AS pin FROM gymos.member_code_access WHERE owner_id=$1 AND member_id=$2',[ctx.owner,m.id])).rows[0]?.pin??null;
    const pin=customPin??newMemberPin(currentPin);
    await c.query('UPDATE gymos.member_code_access SET pin_hash=gymos.member_pin_hash($1),pin_cipher=gymos.member_pin_encrypt($1),pin_must_change=true,version=version+1,revoked=false WHERE owner_id=$2 AND member_id=$3',[pin,ctx.owner,m.id]);
    await c.query('DELETE FROM gymos.member_code_sessions WHERE owner_id=$1 AND member_id=$2',[ctx.owner,m.id]);
    await audit('member.pin.reset');
    return{phone:normalizeMemberPhone(m.phone),pin,revoked:false,needsPhone:false,changeRequired:true};
  }
  const row=(await c.query('SELECT CASE WHEN pin_cipher IS NOT NULL THEN gymos.member_code_decrypt(pin_cipher) END AS pin,revoked,pin_must_change FROM gymos.member_code_access WHERE owner_id=$1 AND member_id=$2',[ctx.owner,m.id])).rows[0]??{pin:null,revoked:false,pin_must_change:true};
  return{phone:normalizeMemberPhone(m.phone),pin:row.revoked?null:row.pin,revoked:row.revoked,needsPhone:!normalizeMemberPhone(m.phone),pinChanged:!row.pin_must_change,changeRequired:!row.revoked&&row.pin_must_change&&!row.pin};
 });
 if(result instanceof Response)return result;
 return reply(result);
}catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);return reply({error:'unavailable'},503);}}
