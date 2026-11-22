export function playNotificationChime(): void {
  if (typeof window === 'undefined') return;
  try {
    const audio = new Audio('/audio/default-announcement-chime.wav');
    audio.volume = 0.8;
    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        synthesizeChime();
      });
    }
  } catch {
    synthesizeChime();
  }
}

function synthesizeChime(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    gain1.gain.setValueAtTime(0.35, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.4);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.15); // A5
    gain2.gain.setValueAtTime(0.4, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.65);
  } catch {}
}

export function dispatchPlatformNotification(title: string, body: string, icon = '/icons/icon-192.png', url='/member', tag?:string): void {
  if (typeof window === 'undefined') return;

  // 1. Notification sound
  playNotificationChime();

  // 2. Web Notification API (modern browsers and installed PWAs)
  const androidApp=/GymEG(?:Members|Manager)Android/i.test(navigator.userAgent);
  if(!androidApp)try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const options={body,icon,tag:tag?'club-message-'+tag.slice(0,24):undefined,renotify:false,data:{url}};
      const fallback=()=>{try{const notification=new Notification(title,options);notification.onclick=()=>{window.focus();if(window.location.pathname!==url)window.location.assign(url);};}catch{}};
      if('serviceWorker'in navigator)void navigator.serviceWorker.getRegistration().then(async registration=>{if(registration)await registration.showNotification(title,options);else fallback();}).catch(fallback);
      else fallback();
    }
  } catch {}

  // 3. Windows Desktop WebView2 host
  try {
    const winHost = (window as unknown as { chrome?: { webview?: { postMessage: (msg: unknown) => void } } }).chrome?.webview;
    if (winHost?.postMessage) {
      winHost.postMessage({
        type: 'gymos-desktop',
        action: 'notification',
        title,
        body,
      });
    }
  } catch {}

  // 4. Android apps intercept these exact same-origin URLs locally; no message is sent to the server.
  if(androidApp)try {void fetch(`/__native_notifications__?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,{cache:'no-store'}).catch(() => {});} catch {}

  // 5. iOS WebKit Host
  try {
    const iosBridge = (window as unknown as {
      webkit?: {
        messageHandlers?: {
          gymosNotificationBridge?: { postMessage: (msg: unknown) => void };
        };
      };
    }).webkit?.messageHandlers?.gymosNotificationBridge;
    if (iosBridge?.postMessage) {
      iosBridge.postMessage({ title, body });
    }
  } catch {}
}

export type NotificationPermissionResult={granted:boolean;native:boolean;prompted:boolean;remote:boolean;configured:boolean;licenseBlocked?:boolean;reason?:string};
async function readLicenseBlocked(response:Response):Promise<boolean>{if(response.status!==403)return false;try{const body=await response.json() as {error?:unknown};return body.error==='licenseReadOnly';}catch{return false;}}
export async function requestNotificationPermission(branch?:string,audience?:'support'):Promise<NotificationPermissionResult>{
 const no=(native=false,prompted=false,configured=true):NotificationPermissionResult=>({granted:false,native,prompted,remote:false,configured});
 if(typeof window==='undefined')return no();
 const androidApp=/GymEG(?:Members|Manager|Support)Android/i.test(navigator.userAgent);
 if(androidApp){
  try{
   const response=await fetch('/__native_notifications_permission__',{cache:'no-store'}),result=await response.json() as {granted?:boolean;requested?:boolean};
   if(!result.granted)return{granted:false,native:true,prompted:result.requested===true,remote:false,configured:true};
   const configResponse=await fetch('/api/fcm-subscriptions',{cache:'no-store'});
   if(!configResponse.ok)return{granted:true,native:true,prompted:result.requested===true,remote:false,configured:false};
   const config=await configResponse.json() as {configured?:boolean};
   if(!config.configured)return{granted:true,native:true,prompted:result.requested===true,remote:false,configured:false};
   for(let attempt=0;attempt<4;attempt++){
    const tokenResponse=await fetch('/__native_fcm_token__',{cache:'no-store'});
    if(tokenResponse.ok){
     const tokenBody=await tokenResponse.json() as {token?:unknown};
     if(typeof tokenBody.token==='string'&&tokenBody.token.length>=80){
      const registered=await fetch('/api/fcm-subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'register',...(branch?{branch}:{}),...(audience?{audience}:{}),token:tokenBody.token}),signal:AbortSignal.timeout(10000)});
      return{granted:true,native:true,prompted:result.requested===true,remote:registered.ok,configured:true,...(await readLicenseBlocked(registered)?{licenseBlocked:true}:{})};
     }
    }
    if(attempt<3)await new Promise(resolve=>setTimeout(resolve,400));
   }
   return{granted:true,native:true,prompted:result.requested===true,remote:false,configured:true};
  }
  catch{return no(true);}
 }
 if(audience==='support')return no(false,false,false);
 if(!('Notification'in window)||!('serviceWorker'in navigator)||!('PushManager'in window))return no();
 let prompted=false,granted=Notification.permission==='granted';
 if(!granted&&Notification.permission!=='denied'){
  prompted=true;
  try{granted=await Notification.requestPermission()==='granted';}catch{return no(false,true);}
 }
 if(!granted)return no(false,prompted);
 // Stage-specific safe failure reasons for support diagnosis. No endpoints,
 // tokens or server internals are exposed, only which stage failed.
 const fail=(reason:string):NotificationPermissionResult=>({granted:true,native:false,prompted,remote:false,configured:true,reason});
 const isMember=location.pathname==='/member'||location.pathname.startsWith('/member/');
 let registration:ServiceWorkerRegistration;
 try{
  registration=await navigator.serviceWorker.register(isMember?'/member-sw.js':'/sw.js',{scope:isMember?'/member':'/'});
 }catch{return fail('sw-register');}
 let config:{configured?:boolean;publicKey?:string|null};
 try{
  const configResponse=await fetch('/api/push-subscriptions',{cache:'no-store'});
  if(!configResponse.ok)return{granted:true,native:false,prompted,remote:false,configured:false};
  config=await configResponse.json() as {configured?:boolean;publicKey?:string|null};
 }catch{return fail('config-fetch');}
 if(!config.configured||!config.publicKey)return{granted:true,native:false,prompted,remote:false,configured:false};
 const key=Uint8Array.from(atob(config.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
 // Structured support code: which call failed, the DOMException name mapped
 // through a fixed allowlist from the W3C Push API (never arbitrary names or
 // message text), plus non-sensitive state: existing-subscription presence,
 // applicationServerKey match, active service worker, notification permission.
 const pushExceptionNames:Record<string,string>={invalidstateerror:'invalidstate',aborterror:'abort',notallowederror:'notallowed',notsupportederror:'notsupported',operationerror:'operation',securityerror:'security'};
 const pushReason=(stage:'get'|'sub',err:unknown,existing:PushSubscription|null):string=>{
  const raw=err&&typeof err==='object'&&'name'in err?(err as {name?:unknown}).name:'';
  const lowered=typeof raw==='string'?raw.toLowerCase():'';
  const name=pushExceptionNames[lowered]??'unknown';
  let keyState='keyna';
  if(existing){
   try{
    const existingKey=existing.options?.applicationServerKey;
    const existingBytes=existingKey?new Uint8Array(existingKey):null;
    keyState=existingBytes&&existingBytes.length===key.length&&existingBytes.every((b,i)=>b===key[i])?'keymatch':'keydiff';
   }catch{keyState='keyna';}
  }
  const swState=registration.active?'swact':'swother';
  const perm=Notification.permission==='granted'?'permg':Notification.permission==='denied'?'permd':'permp';
  return `push-subscribe-${stage}-${name}-sub${existing?'1':'0'}-${keyState}-${swState}-${perm}`;
 };
 let subscription:PushSubscription;
 let existing:PushSubscription|null=null;
 try{existing=await registration.pushManager.getSubscription();}
 catch(err){return fail(pushReason('get',err,null));}
 if(existing)subscription=existing;
 else{
  try{subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});}
  catch(err){return fail(pushReason('sub',err,null));}
 }
 let response:Response;
 try{
  response=await fetch('/api/push-subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'subscribe',...(branch?{branch}:{}),subscription:subscription.toJSON()}),signal:AbortSignal.timeout(10000)});
 }catch{return fail('post-network');}
 if(!response.ok){if(response.status===503)return{granted:true,native:false,prompted,remote:false,configured:false};return{granted:true,native:false,prompted,remote:false,configured:true,reason:'http-'+response.status,...(await readLicenseBlocked(response)?{licenseBlocked:true}:{})};}
 return{granted:true,native:false,prompted,remote:true,configured:true};
}
export async function disablePushNotifications(branch?:string,audience?:'support'):Promise<boolean>{
 if(typeof window==='undefined')return false;
 const androidApp=/GymEG(?:Members|Manager|Support)Android/i.test(navigator.userAgent);
 if(androidApp){
  try{const response=await fetch('/__native_fcm_token__',{cache:'no-store'});if(response.status===404)return true;if(!response.ok)return false;const body=await response.json() as {token?:unknown};if(typeof body.token!=='string')return true;const result=await fetch('/api/fcm-subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'unregister',...(branch?{branch}:{}),...(audience?{audience}:{}),token:body.token}),signal:AbortSignal.timeout(10000)});return result.ok;}catch{return false;}
 }
 if(audience==='support')return false;
 if(!('serviceWorker'in navigator))return false;
 try{
  const isMember=location.pathname==='/member'||location.pathname.startsWith('/member/');
  const registration=await navigator.serviceWorker.getRegistration(isMember?'/member':'/');
  const subscription=await registration?.pushManager.getSubscription();
  if(!subscription)return true;
  const response=await fetch('/api/push-subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'unsubscribe',...(branch?{branch}:{}),subscription:subscription.toJSON()}),signal:AbortSignal.timeout(10000)});
  return response.ok;
 }catch{return false;}
}
