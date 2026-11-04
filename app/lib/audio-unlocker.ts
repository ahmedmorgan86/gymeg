'use client';

type UnlockListener = (unlocked: boolean) => void;

class AudioUnlockerManager {
  private unlocked = false;
  private audioContext: AudioContext | null = null;
  private listeners = new Set<UnlockListener>();
  private wakeLock: WakeLockSentinel | null = null;
  private channel: BroadcastChannel | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.initWindow();
    }
  }

  private initWindow() {
    // BroadcastChannel for cross-tab audio activity
    try {
      this.channel = new BroadcastChannel('gymeg_announcements_channel');
    } catch {
      // BroadcastChannel not available
    }

    // Listen to user interactions anywhere in window
    const onInteraction = () => {
      void this.unlock();
      window.removeEventListener('click', onInteraction, true);
      window.removeEventListener('keydown', onInteraction, true);
      window.removeEventListener('pointerdown', onInteraction, true);
      window.removeEventListener('touchstart', onInteraction, true);
    };

    window.addEventListener('click', onInteraction, { capture: true, passive: true });
    window.addEventListener('keydown', onInteraction, { capture: true, passive: true });
    window.addEventListener('pointerdown', onInteraction, { capture: true, passive: true });
    window.addEventListener('touchstart', onInteraction, { capture: true, passive: true });
  }

  public getAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.audioContext = new AudioCtx();
      }
    }
    return this.audioContext;
  }

  public isUnlocked(): boolean {
    return this.unlocked;
  }

  public markPlaybackBlocked(): void {
    this.unlocked = false;
    this.notifyListeners(false);
  }

  public async unlock(): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    try {
      const ctx = this.getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        // Play silent sound to warm up the audio hardware
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.001; // virtually silent
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(0);
        osc.stop(ctx.currentTime + 0.05);
      }

      // Also create and play an empty audio element to unlock HTMLAudioElement
      let htmlAudioReady = false;
      if (typeof Audio !== 'undefined') {
        const silentAudio = new Audio('data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==');
        silentAudio.volume = 0.01;
        try {
          await silentAudio.play();
          htmlAudioReady = true;
        } catch {
          // The browser may still prohibit scheduled HTMLAudioElement playback.
        } finally {
          silentAudio.pause();
        }
      }

      this.unlocked = htmlAudioReady;
      this.notifyListeners(htmlAudioReady);
      return htmlAudioReady;
    } catch (e) {
      console.warn('Audio unlock failed:', e);
      return false;
    }
  }

  public subscribe(fn: UnlockListener): () => void {
    this.listeners.add(fn);
    fn(this.isUnlocked());
    return () => this.listeners.delete(fn);
  }

  private notifyListeners(unlocked: boolean) {
    this.listeners.forEach(fn => {
      try { fn(unlocked); } catch {}
    });
  }

  public async requestWakeLock(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return false;
    try {
      if (!this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null;
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  public broadcast(message: unknown): void {
    try {
      this.channel?.postMessage(message);
    } catch {}
  }

  public onBroadcast(handler: (msg: unknown) => void): () => void {
    if (!this.channel) return () => {};
    const listener = (event: MessageEvent) => handler(event.data);
    this.channel.addEventListener('message', listener);
    return () => this.channel?.removeEventListener('message', listener);
  }
}

export const audioUnlocker = new AudioUnlockerManager();

/**
 * Executes audio.play() safely and categorizes autoplay/gesture errors.
 */
export async function safePlayAudio(audio: HTMLAudioElement): Promise<{
  success: boolean;
  requiresGesture: boolean;
  error?: string;
}> {
  try {
    await audio.play();
    return { success: true, requiresGesture: false };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isGestureRequired =
      errorMsg.includes('user gesture') ||
      errorMsg.includes('NotAllowedError') ||
      errorMsg.includes('not allowed to start') ||
      errorMsg.includes('interact with the document');

    return {
      success: false,
      requiresGesture: isGestureRequired,
      error: errorMsg
    };
  }
}
