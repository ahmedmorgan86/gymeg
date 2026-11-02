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

export function dispatchPlatformNotification(title: string, body: string, icon = '/icons/brand-main.svg'): void {
  if (typeof window === 'undefined') return;

  // 1. Notification sound
  playNotificationChime();

  // 2. Web Notification API (Modern browsers, PWA)
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon });
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

  // 4. Android Host (native interception and JavascriptInterface)
  try {
    const androidBridge = (window as unknown as { GymOSAndroid?: { showNotification?: (title: string, body: string) => void } }).GymOSAndroid;
    if (androidBridge?.showNotification) {
      androidBridge.showNotification(title, body);
    } else {
      void fetch(`/__native_notifications__?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`).catch(() => {});
    }
  } catch {}

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

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  try {
    if (Notification.permission === 'granted') return true;
    if (Notification.permission !== 'denied') {
      const perm = await Notification.requestPermission();
      return perm === 'granted';
    }
  } catch {}
  return false;
}
