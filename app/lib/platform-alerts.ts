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

export function dispatchPlatformNotification(title: string, body: string, icon = '/icons/brand-main.svg', url='/member'): void {
  if (typeof window === 'undefined') return;

  // 1. Notification sound
  playNotificationChime();

  // 2. Web Notification API (modern browsers and installed PWAs)
  const androidApp=/GymEG(?:Members|Manager)Android/i.test(navigator.userAgent);
  if(!androidApp)try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const options={body,icon,data:{url}};
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

export async function requestNotificationPermission(): Promise<{granted:boolean;native:boolean;prompted:boolean}> {
  if (typeof window === 'undefined') return {granted:false,native:false,prompted:false};
  if(/GymEG(?:Members|Manager)Android/i.test(navigator.userAgent)) {
    try {const response=await fetch('/__native_notifications_permission__',{cache:'no-store'});const result=await response.json() as {granted?:boolean;requested?:boolean};return {granted:result.granted===true,native:true,prompted:result.requested===true};} catch {return {granted:false,native:true,prompted:false};}
  }
  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') return {granted:true,native:false,prompted:false};
      if (Notification.permission !== 'denied') return {granted:await Notification.requestPermission()==='granted',native:false,prompted:false};
    }
  } catch {}
  return {granted:false,native:false,prompted:false};
}
