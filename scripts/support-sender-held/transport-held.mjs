// HELD isolated transport preparation. No default network, credentials or entrypoint.
// All dependencies injected; tests must prohibit actual network.
import {message} from './business-worker.mjs';
export function retryNotBefore(response,now=Date.now()){const raw=response.headers?.get('retry-after');let delay=0;if(raw){if(/^\d+$/.test(raw))delay=Number(raw)*1000;else{const parsed=Date.parse(raw);if(Number.isFinite(parsed))delay=Math.max(0,parsed-now)}}if(!Number.isFinite(delay)||delay<0||delay>7*86400000)return null;return new Date(now+Math.max(response.status===429?60000:1000,delay)).toISOString();}
export function makeTransport({projectId,fetchImpl,getBearer,resolveToken,timeoutMs=8000}){
 if(typeof projectId!=='string'||!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)||typeof fetchImpl!=='function'||typeof getBearer!=='function'||typeof resolveToken!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>8000)throw Error('invalid isolated transport config');
 return async(e,r,m)=>{
  if(m.title!==message.title||m.body!==message.body||m.url!==message.url||Object.keys(m).length!==3)throw Error('unexpected support content');
  const controller=new AbortController();let timer;const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve('unknown')},timeoutMs)});
  // Timeout cannot prove an in-flight external request did not send. Dependencies
  // must honor AbortSignal; Promise.race bounds returned wait, not hidden work.
  const work=(async()=>{let token,bearer;try{token=await resolveToken(e,r,controller.signal);if(controller.signal.aborted)return'unknown';if(typeof token!=='string'||token.length<20||token.length>4096)return'unknown';bearer=await getBearer(controller.signal);if(controller.signal.aborted)return'unknown';if(typeof bearer!=='string'||!bearer)return'unknown';}catch{return'unknown'}
   let response;try{response=await fetchImpl('https://fcm.googleapis.com/v1/projects/'+encodeURIComponent(projectId)+'/messages:send',{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify({message:{token,notification:{title:m.title,body:m.body},data:{url:m.url},android:{priority:'HIGH',notification:{channel_id:'gymeg_support',click_action:'GYMEG_SUPPORT_NOTIFICATION'}}}}),signal:controller.signal});}catch{return'unknown'}
   if(controller.signal.aborted)return'unknown';if(response.ok)return'accepted';let payload;try{payload=await response.json()}catch{return'unknown'}
   // Only structured FCM UNREGISTERED retires this exact snapshot version.
   // A bare404 may be missing project/endpoint, never treat it as invalid token.
   const unregistered=response.status===404&&Array.isArray(payload?.error?.details)&&payload.error.details.some(d=>d?.['@type']==='type.googleapis.com/google.firebase.fcm.v1.FcmError'&&d.errorCode==='UNREGISTERED');
   if(unregistered)return'invalid';if(response.status===429||response.status>=500){const retryAt=retryNotBefore(response);return retryAt?{status:'retry',retryAt}:'unknown';}return'unknown';
  })();
  try{return await Promise.race([work,deadline])}finally{clearTimeout(timer)}
 };
}
