export type AudioPart = {
  id: string;
  name: string;
  size: number;
  duration?: number;
  blob?: Blob;
};

export const DEFAULT_CHIME_PART: AudioPart = {
  id: 'default-chime',
  name: 'نغمة النداء الافتراضية (Chime)',
  size: 620038,
  duration: 3.51
};

export type SequenceItem = {
  id: string;
  name: string;
  // Main announcement (mandatory)
  main: AudioPart;
  mainVolume: number; // 0 - 100
  mainRepeats: number; // 1 - 99
  mainGap: number; // seconds between main repeats

  // Intro music (optional)
  before?: AudioPart;
  beforeEnabled: boolean;
  beforeVolume: number;
  beforeRepeats: number;
  beforeGap: number; // seconds after intro finishes before main begins
  beforeFadeIn?: number; // seconds
  beforeFadeOut?: number; // seconds

  // Outro music (optional)
  after?: AudioPart;
  afterEnabled: boolean;
  afterVolume: number;
  afterRepeats: number;
  afterGap: number; // seconds after main finishes before outro begins
  afterFadeIn?: number; // seconds
  afterFadeOut?: number; // seconds
};

export type PlaybackStatus = {
  activeId: string | null;
  phase: 'idle' | 'before' | 'main' | 'after' | 'gap';
  repeatIndex: number;
  totalRepeats: number;
  paused: boolean;
};

export function delay(ms: number, signal?: { cancelled: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.cancelled) return reject(new Error('cancelled'));
    const timer = setTimeout(() => resolve(), ms);
    if (signal) {
      const check = setInterval(() => {
        if (signal.cancelled) {
          clearTimeout(timer);
          clearInterval(check);
          reject(new Error('cancelled'));
        }
      }, 50);
    }
  });
}

/**
 * Calculates the exact expected timeline of an announcement sequence in seconds.
 */
export function calculateTimeline(item: SequenceItem): {
  totalSeconds: number;
  mainStartSeconds: number;
} {
  let time = 0;
  if (item.beforeEnabled && item.before) {
    const beforeDur = item.before.duration || 0;
    time += (beforeDur * Math.max(1, item.beforeRepeats));
    time += Math.max(0, item.beforeGap);
  }
  const mainStartSeconds = time;

  const mainDur = item.main.duration || 0;
  const mainReps = Math.max(1, item.mainRepeats);
  time += (mainDur * mainReps);
  if (mainReps > 1) {
    time += (mainReps - 1) * Math.max(0, item.mainGap);
  }

  if (item.afterEnabled && item.after) {
    time += Math.max(0, item.afterGap);
    const afterDur = item.after.duration || 0;
    time += (afterDur * Math.max(1, item.afterRepeats));
  }

  return { totalSeconds: time, mainStartSeconds };
}

/**
 * Queue coordinator to guarantee only one announcement sequence runs at any moment.
 */
class AnnouncementAudioQueue {
  private currentPromise: Promise<void> = Promise.resolve();
  private activeCancelSignal: { cancelled: boolean } | null = null;
  private isPreviewRunning = false;

  public async enqueue(
    runner: (signal: { cancelled: boolean }) => Promise<void>,
    isManualPreview = false
  ): Promise<void> {
    if (!isManualPreview && this.isPreviewRunning && this.activeCancelSignal) {
      this.activeCancelSignal.cancelled = true;
      this.activeCancelSignal = null;
      this.isPreviewRunning = false;
    }

    const mySignal = { cancelled: false };
    if (isManualPreview) {
      this.isPreviewRunning = true;
    }
    this.activeCancelSignal = mySignal;

    const task = async () => {
      try {
        await runner(mySignal);
      } finally {
        if (this.activeCancelSignal === mySignal) {
          this.activeCancelSignal = null;
          if (isManualPreview) this.isPreviewRunning = false;
        }
      }
    };

    this.currentPromise = this.currentPromise.then(task, task);
    return this.currentPromise;
  }

  public cancelCurrent(): void {
    if (this.activeCancelSignal) {
      this.activeCancelSignal.cancelled = true;
      this.activeCancelSignal = null;
      this.isPreviewRunning = false;
    }
  }
}

export const audioQueue = new AnnouncementAudioQueue();

export const MAX_ANNOUNCEMENT_DURATION_SECONDS = 30.0;
export const SAFE_MAX_DURATION_SECONDS = 29.5;

/**
 * Validates whether the complete announcement sequence stays strictly under the mandatory 30-second limit.
 */
export function validateAnnouncementSequence(item: SequenceItem): {
  valid: boolean;
  totalSeconds: number;
  exceedsLimit: boolean;
  error?: string;
} {
  const timeline = calculateTimeline(item);
  const exceedsLimit = timeline.totalSeconds >= MAX_ANNOUNCEMENT_DURATION_SECONDS;
  return {
    valid: !exceedsLimit,
    totalSeconds: Number(timeline.totalSeconds.toFixed(2)),
    exceedsLimit,
    error: exceedsLimit
      ? `إجمالي مدة النداء (${timeline.totalSeconds.toFixed(1)} ثانية) تتجاوز الحد الأقصى 30 ثانية.`
      : undefined
  };
}
