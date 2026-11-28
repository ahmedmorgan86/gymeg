'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Pause,
  Play,
  Plus,
  Square,
  Trash2,
  Upload,
  Volume2,
  Clock,
  Calendar,
  Music,
  ShieldCheck,
  AlertTriangle,
  CheckCircle
} from 'lucide-react';
import type { GymState, Operation } from './lib/domain';
import type { Role } from './lib/access';
import { useConfirmDialog } from '../components/ui/use-confirm-dialog';
import {
  audioQueue,
  calculateTimeline,
  delay,
  DEFAULT_CHIME_PART,
  validateAnnouncementSequence,
  MAX_ANNOUNCEMENT_DURATION_SECONDS,
  type AudioPart,
  type SequenceItem
} from './lib/announcement-audio';
import {
  composeAnnouncementAudio
} from './lib/announcement-composer';
import { audioUnlocker, safePlayAudio } from './lib/audio-unlocker';
import VoxStudioPanel from './vox-studio-panel';
import { scheduledMinuteSamples, scheduledWallClockParts } from './lib/announcement-schedule';
import { shouldRunBrowserAnnouncementScheduler } from './lib/announcement-runtime';
import { DEFAULT_CHIME_BASE64 } from './lib/default-chime-data';

export type Announcement = SequenceItem & {
  branch: string;
  schedule: 'daily' | 'weekly' | 'once' | 'interval';
  days: number[]; // 0 = Sunday, 1 = Monday, ... 6 = Saturday
  times: string[]; // ['08:00', '10:00']
  date?: string; // YYYY-MM-DD for 'once'
  startDate: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  interval: number; // every N days
  enabled: boolean;
  createdAt: string;
  composedId?: string;
  totalDurationSeconds?: number;
};

function getLocalDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLocalTimeStr(d: Date = new Date()): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function normalizeTimeStr(t: string): string {
  const tr = String(t).trim();
  const [h, m] = tr.split(':');
  if (h && m) {
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }
  return tr;
}

export type ExecutionLog = {
  id: string;
  announcementId: string;
  name: string;
  date: string;
  scheduledTime: string;
  actualStartTime?: string;
  actualEndTime?: string;
  status: 'مجدول' | 'قيد التشغيل' | 'في قائمة الانتظار' | 'مكتمل' | 'متوقف' | 'فشل التشغيل';
  error?: string;
};

const DB_NAME = 'gymeg-announcements-storage';
const DB_VERSION = 1;

function openAudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('audio_blobs')) {
        req.result.createObjectStore('audio_blobs', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persistBlob(part: AudioPart): Promise<void> {
  if (!part.blob) return;
  const db = await openAudioDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('audio_blobs', 'readwrite');
    tx.objectStore('audio_blobs').put(part);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function retrieveBlob(id: string): Promise<Blob | undefined> {
  if (id === DEFAULT_CHIME_PART.id) {
    try {
      const res = await fetch('/audio/default-announcement-chime.wav');
      if (res.ok) return await res.blob();
    } catch {
      // fallback to embedded base64
    }
    try {
      const res = await fetch(DEFAULT_CHIME_BASE64);
      return await res.blob();
    } catch {
      // fallback to database
    }
  }
  const db = await openAudioDb();
  return new Promise<Blob | undefined>((resolve, reject) => {
    const tx = db.transaction('audio_blobs', 'readonly');
    const req = tx.objectStore('audio_blobs').get(id);
    req.onsuccess = () => {
      db.close();
      resolve(req.result?.blob);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function deleteBlobs(ids: string[]): Promise<void> {
  const db = await openAudioDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('audio_blobs', 'readwrite');
    const store = tx.objectStore('audio_blobs');
    ids.forEach(id => store.delete(id));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

const DAYS_NAMES_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LOG_STATUS_EN: Record<string, string> = {
  'مجدول': 'Scheduled',
  'قيد التشغيل': 'Playing',
  'في قائمة الانتظار': 'Queued',
  'مكتمل': 'Completed',
  'متوقف': 'Stopped',
  'فشل التشغيل': 'Playback failed'
};
const storageKey = (scope: string) => `gymeg.announcements.v3.${scope}`;
const logsKey = (scope: string) => `gymeg.announcements.v3.logs.${scope}`;

const DAYS_NAMES = [
  'الأحد',
  'الاثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت'
];

async function probeAudioDuration(file: File | Blob): Promise<number> {
  return new Promise<number>((resolve) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const url = URL.createObjectURL(file);
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    audio.src = url;
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Synchronize announcements state with native host platforms:
 * 1. Windows WPF WebView2 (chrome.webview)
 * 2. Android WebView JavascriptInterface (window.GymOSAndroid)
 * 3. iOS WKWebView ScriptMessageHandler (window.webkit.messageHandlers.gymosAnnouncementBridge)
 */
function syncWithNativePlatforms(itemsList: Announcement[], timezone: string): void {
  if (typeof window === 'undefined') return;

  void (async () => {
    const payload = await Promise.all(
      itemsList.map(async item => {
        let wavBase64: string | undefined;
        try {
          const cid = item.composedId || `comp_${item.id}`;
          const composedBlob = await retrieveBlob(cid);
          if (composedBlob) {
            wavBase64 = await blobToBase64(composedBlob);
          }
        } catch {}
        return {
          id: item.id,
          name: item.name,
          branch: item.branch,
          timezone,
          enabled: item.enabled,
          schedule: item.schedule,
          days: item.days,
          times: item.times,
          date: item.date,
          startDate: item.startDate,
          endDate: item.endDate,
          interval: item.interval,
          totalDurationSeconds: item.totalDurationSeconds ?? calculateTimeline(item).totalSeconds,
          composedId: item.composedId,
          wavBase64
        };
      })
    );

    // 1. Windows WPF Host
    try {
      const winHost = (window as unknown as { chrome?: { webview?: { postMessage: (msg: unknown) => void } } }).chrome?.webview;
      if (winHost?.postMessage) {
        winHost.postMessage({
          type: 'gymos-desktop',
          action: 'announcementsSync',
          items: payload
        });
      }
    } catch {}

    // 2. Android Host (via trusted WebView request interception or native bridge)
    try {
      const jsonStr = JSON.stringify(payload);
      const androidBridge = (window as unknown as { GymOSAndroid?: { syncAnnouncements: (json: string) => void } }).GymOSAndroid;
      if (androidBridge?.syncAnnouncements) {
        androidBridge.syncAnnouncements(jsonStr);
      } else if (typeof navigator !== 'undefined' && /GymOSManagerAndroid|GymEGManagerAndroid/i.test(navigator.userAgent)) {
        const strippedPayload = payload.map(item => ({ ...item, wavBase64: undefined }));
        void fetch(`/__native_announcements__?payload=${encodeURIComponent(JSON.stringify(strippedPayload))}`).catch(() => {});
      }
    } catch {}

    // 3. iOS Host
    try {
      const iosBridge = (window as unknown as {
        webkit?: {
          messageHandlers?: {
            gymosAnnouncementBridge?: { postMessage: (msg: unknown) => void };
          };
        };
      }).webkit?.messageHandlers?.gymosAnnouncementBridge;
      if (iosBridge?.postMessage) {
        iosBridge.postMessage({
          action: 'sync',
          items: payload
        });
      }
    } catch {}
  })();
}

function dispatchSpeechActivity(detail: { id: string; active: boolean }) {
  if (typeof window === 'undefined') return;
  try {
    const Ctor = (window.CustomEvent ?? (typeof CustomEvent !== 'undefined' ? CustomEvent : null));
    if (Ctor) {
      window.dispatchEvent(new Ctor('gymos-speech-activity', { detail }));
    }
  } catch {}
}

export default function Announcements({
  state,
  branch,
  owner,
  ar,
  visible
}: {
  state: GymState;
  branch: string;
  owner: string;
  legacyOwner?: string;
  ar: boolean;
  role: Role;
  visible: boolean;
  busy: boolean;
  mutate: (op: Omit<Operation, 'branch'> & {type: string}) => Promise<boolean>;
}) {
  const scope = `${owner}|${branch}`;
  const t = (a: string, e: string) => ar ? a : e;
  const chimeName = (n?: string) => (n === DEFAULT_CHIME_PART.name ? t(n, 'Default chime') : n);
  const { confirm, dialog } = useConfirmDialog();
  const [items, setItems] = useState<Announcement[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(storageKey(scope));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [logs, setLogs] = useState<ExecutionLog[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const savedLogs = localStorage.getItem(logsKey(scope));
      return savedLogs ? JSON.parse(savedLogs) : [];
    } catch {
      return [];
    }
  });
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [timeInput, setTimeInput] = useState('');
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' | 'warning' } | null>(null);

  // Audio unlock state for browser autoplay policy
  const [isAudioUnlocked, setIsAudioUnlocked] = useState<boolean>(() => audioUnlocker.isUnlocked());
  const isNativeAudioHost = useSyncExternalStore(
    () => () => {},
    () => {
      const nativeHost = window as unknown as {
        chrome?: { webview?: { postMessage?: (message: unknown) => void } };
        GymOSAndroid?: { syncAnnouncements?: (json: string) => void };
        webkit?: { messageHandlers?: { gymosAnnouncementBridge?: unknown } };
      };
      return !shouldRunBrowserAnnouncementScheduler({
        windows: Boolean(nativeHost.chrome?.webview?.postMessage),
        androidBridge: Boolean(nativeHost.GymOSAndroid?.syncAnnouncements),
        ios: Boolean(nativeHost.webkit?.messageHandlers?.gymosAnnouncementBridge),
        userAgent: navigator.userAgent
      });
    },
    () => false
  );

  // Playback control state
  const [currentPlayback, setCurrentPlayback] = useState<{
    activeId: string | null;
    phaseName: string;
    repeatIndex: number;
    totalRepeats: number;
    isPaused: boolean;
  } | null>(null);

  const activeAudioElement = useRef<HTMLAudioElement | null>(null);
  const playbackGeneration = useRef<number>(0);
  const firedOccurrences = useRef<Set<string>>(new Set<string>());
  const lastScheduleTick = useRef(0);
  const timezoneRef = useRef(state.settings.timezone);

  useEffect(() => {
    timezoneRef.current = state.settings.timezone;
  }, [state.settings.timezone]);

  // Subscribe to audio unlock events and keep awake
  useEffect(() => {
    const unsubscribe = audioUnlocker.subscribe((unlocked) => {
      setIsAudioUnlocked(unlocked);
    });

    // Cross-tab deduplication handler
    const unbindBroadcast = audioUnlocker.onBroadcast((msg) => {
      if (typeof msg === 'object' && msg !== null && 'type' in msg) {
        const payload = msg as { type: string; occurrenceKey?: string };
        if (payload.type === 'ANNOUNCEMENT_FIRED' && payload.occurrenceKey) {
          firedOccurrences.current.add(payload.occurrenceKey);
        }
      }
    });

    return () => {
      unsubscribe();
      unbindBroadcast();
      if (typeof window !== 'undefined') {
        dispatchSpeechActivity({ id: '*', active: false });
      }
    };
  }, []);

  const handleUnlockAudio = async () => {
    const success = await audioUnlocker.unlock();
    await audioUnlocker.requestWakeLock();
    if (success) {
      setIsAudioUnlocked(true);
      setStatusMessage({
        text: t('تم السماح بتشغيل الصوت في هذه الجلسة. أبقِ التطبيق مفتوحًا وفي الواجهة؛ المتصفح لا يضمن التشغيل بعد إغلاق الصفحة أو إيقافها بالخلفية.', 'Audio is allowed for this session. Keep the app open and in the foreground; the browser does not guarantee playback after the page is closed or sent to the background.'),
        type: 'success'
      });
    } else {
      audioUnlocker.markPlaybackBlocked();
      setIsAudioUnlocked(false);
      setStatusMessage({
        text: t('تعذر تفعيل الصوت التلقائي بدون تفاعل مباشر مع الصفحة. يرجى النقر والمحاولة مجددًا.', 'Automatic audio could not be enabled without direct interaction with the page. Please click and try again.'),
        type: 'warning'
      });
    }
  };

  const blankAnnouncement = (): Announcement => ({
    id: crypto.randomUUID(),
    branch,
    name: '',
    main: null as never,
    mainVolume: 100,
    mainRepeats: 1,
    mainGap: 0,
    // Start Chime
    before: { ...DEFAULT_CHIME_PART },
    beforeEnabled: true,
    beforeVolume: 80,
    beforeRepeats: 1,
    beforeGap: 1,
    beforeFadeIn: 0,
    beforeFadeOut: 0,
    // End Chime (Identical to Start Chime)
    after: { ...DEFAULT_CHIME_PART },
    afterEnabled: true,
    afterVolume: 80,
    afterRepeats: 1,
    afterGap: 1,
    afterFadeIn: 0,
    afterFadeOut: 0,
    schedule: 'daily',
    days: [0, 1, 2, 3, 4, 5, 6],
    times: ['08:00'],
    startDate: getLocalDateStr(),
    interval: 1,
    enabled: true,
    createdAt: new Date().toISOString()
  });

  // Sync from local storage when scope changes & sync native schedulers
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const raw = localStorage.getItem(storageKey(scope));
        const loaded: Announcement[] = raw ? JSON.parse(raw) : [];
        setItems(loaded);
        syncWithNativePlatforms(loaded, timezoneRef.current);
        const savedLogs = localStorage.getItem(logsKey(scope));
        setLogs(savedLogs ? JSON.parse(savedLogs) : []);
      } catch {
        // storage fallback
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [scope]);

  // Persist announcements metadata to localStorage and broadcast to native hosts
  const saveToStorage = useCallback((updated: Announcement[]) => {
    setItems(updated);
    try {
      const stripped = updated.map(({ main, before, after, ...rest }) => ({
        ...rest,
        main: { id: main.id, name: main.name, size: main.size, duration: main.duration },
        before: before ? { id: before.id, name: before.name, size: before.size, duration: before.duration } : undefined,
        after: after ? { id: after.id, name: after.name, size: after.size, duration: after.duration } : undefined
      }));
      localStorage.setItem(storageKey(scope), JSON.stringify(stripped));
      syncWithNativePlatforms(updated, timezoneRef.current);
    } catch {
      setStatusMessage({ text: ar ? 'تحذير: تعذر مزامنة البيانات في التخزين المحلي.' : 'Warning: could not sync data to local storage.', type: 'error' });
    }
  }, [scope, ar]);

  const addLogEntry = useCallback((entry: ExecutionLog) => {
    setLogs(prev => {
      const next = [entry, ...prev.filter(l => l.id !== entry.id)].slice(0, 150);
      try {
        localStorage.setItem(logsKey(scope), JSON.stringify(next));
      } catch { /* ignore quota */ }
      return next;
    });
  }, [scope]);

  const clearLogs = () => {
    setLogs([]);
    localStorage.removeItem(logsKey(scope));
    setStatusMessage({ text: t('تم تنظيف سجل التشغيل بالكامل.', 'The playback log was cleared.'), type: 'info' });
  };

  // Play a single audio part with optional fade and gap using safe autoplay unlocker
  const playPartWithFade = async (
    blob: Blob,
    volumePercent: number,
    fadeInSec = 0,
    fadeOutSec = 0,
    currentGen: number
  ): Promise<void> => {
    if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    activeAudioElement.current = audio;

    const targetVolume = Math.max(0, Math.min(1, volumePercent / 100));
    audio.volume = fadeInSec > 0 ? 0 : targetVolume;

    return new Promise<void>((resolve, reject) => {
      let fadeTimer: NodeJS.Timeout | null = null;
      let fadeInterval: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (fadeTimer) clearTimeout(fadeTimer);
        if (fadeInterval) clearInterval(fadeInterval);
        URL.revokeObjectURL(url);
        if (activeAudioElement.current === audio) {
          activeAudioElement.current = null;
        }
      };

      audio.onended = () => {
        cleanup();
        resolve();
      };

      audio.onerror = () => {
        cleanup();
        reject(new Error('فشل فك تشفير الملف الصوتي'));
      };

      audio.onplay = () => {
        // Fade in
        if (fadeInSec > 0) {
          const steps = 20;
          const stepTime = (fadeInSec * 1000) / steps;
          const volStep = targetVolume / steps;
          let currentVol = 0;
          fadeInterval = setInterval(() => {
            currentVol = Math.min(targetVolume, currentVol + volStep);
            audio.volume = currentVol;
            if (currentVol >= targetVolume && fadeInterval) {
              clearInterval(fadeInterval);
            }
          }, stepTime);
        }

        // Fade out
        if (fadeOutSec > 0 && audio.duration && Number.isFinite(audio.duration)) {
          const fadeStartMs = Math.max(0, (audio.duration - fadeOutSec) * 1000);
          fadeTimer = setTimeout(() => {
            const steps = 20;
            const stepTime = (fadeOutSec * 1000) / steps;
            const volStep = audio.volume / steps;
            const outInterval = setInterval(() => {
              audio.volume = Math.max(0, audio.volume - volStep);
              if (audio.volume <= 0) clearInterval(outInterval);
            }, stepTime);
          }, fadeStartMs);
        }
      };

      // Play via safePlayAudio
      void safePlayAudio(audio).then(result => {
        if (!result.success) {
          cleanup();
          if (result.requiresGesture) {
            reject(new Error('play() can only be initiated by a user gesture'));
          } else {
            reject(new Error(result.error || 'فشل تشغيل الصوت'));
          }
        }
      });
    });
  };

  // Run full 3-part sequence: Alert Chime -> Gap -> Main (Repeats) -> Gap -> Alert Chime
  const executeSequence = async (item: Announcement, isScheduled = false) => {
    const currentGen = ++playbackGeneration.current;
    const nowStamp = new Date();
    const logId = crypto.randomUUID();

    if (isScheduled) {
      addLogEntry({
        id: logId,
        announcementId: item.id,
        name: item.name,
        date: nowStamp.toISOString().slice(0, 10),
        scheduledTime: nowStamp.toTimeString().slice(0, 5),
        actualStartTime: nowStamp.toISOString(),
        status: 'قيد التشغيل'
      });
    }

    // Duck background music in music-room.tsx
    if (typeof window !== 'undefined') {
      dispatchSpeechActivity({ id: item.id, active: true });
    }

    try {
      // 1. Fetch Blobs from IndexedDB
      const mainBlob = await retrieveBlob(item.main.id);
      if (!mainBlob) throw new Error(t('ملف النداء الصوتي الأساسي غير موجود بالتخزين المحلي', 'Main announcement file is missing from local storage'));

      // The chime is identical for Start and End
      const chimeId = item.before?.id || DEFAULT_CHIME_PART.id;
      const chimeBlob = await retrieveBlob(chimeId);
      if (!chimeBlob) throw new Error(t('ملف صوت التنبيه (Chime) غير متوفر', 'Alert chime file is not available'));

      // Check for pre-composed single-file playback if available
      if (item.composedId) {
        const composedBlob = await retrieveBlob(item.composedId);
        if (composedBlob) {
          setCurrentPlayback({
            activeId: item.id,
            phaseName: t(`التسلسل الصوتي الكامل (تنبيه ➔ نداء ➔ تنبيه)`, `Full sequence (chime ➔ announcement ➔ chime)`),
            repeatIndex: 1,
            totalRepeats: 1,
            isPaused: false
          });
          await playPartWithFade(composedBlob, 100, 0, 0, currentGen);

          if (isScheduled) {
            addLogEntry({
              id: logId,
              announcementId: item.id,
              name: item.name,
              date: nowStamp.toISOString().slice(0, 10),
              scheduledTime: nowStamp.toTimeString().slice(0, 5),
              actualStartTime: nowStamp.toISOString(),
              actualEndTime: new Date().toISOString(),
              status: 'مكتمل'
            });
          }
          setCurrentPlayback(null);
          return;
        }
      }

      // 2. Part 1: Start Alert Chime (Mandatory)
      if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
      setCurrentPlayback({
        activeId: item.id,
        phaseName: t(`الجزء 1: صوت تنبيه البداية (Alert Chime)`, `Part 1: start alert chime`),
        repeatIndex: 1,
        totalRepeats: 1,
        isPaused: false
      });
      await playPartWithFade(chimeBlob, item.beforeVolume ?? 80, item.beforeFadeIn ?? 0, item.beforeFadeOut ?? 0, currentGen);

      // Gap after start chime
      const startGap = Math.max(0, item.beforeGap ?? 1);
      if (startGap > 0) {
        if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
        setCurrentPlayback({
          activeId: item.id,
          phaseName: t(`فاصل بعد صوت البداية (${startGap} ثانية)`, `Gap after the start chime (${startGap} seconds)`),
          repeatIndex: 1,
          totalRepeats: 1,
          isPaused: false
        });
        await delay(startGap * 1000);
      }

      // 3. Part 2: Main Announcement (Repeated as configured)
      const mainReps = Math.max(1, item.mainRepeats);
      for (let r = 0; r < mainReps; r++) {
        if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
        setCurrentPlayback({
          activeId: item.id,
          phaseName: t(`الجزء 2: النداء الأساسي (${r + 1} من ${mainReps})`, `Part 2: main announcement (${r + 1} of ${mainReps})`),
          repeatIndex: r + 1,
          totalRepeats: mainReps,
          isPaused: false
        });
        await playPartWithFade(mainBlob, item.mainVolume ?? 100, 0, 0, currentGen);

        // Gap between main repeats
        if (r < mainReps - 1 && item.mainGap > 0) {
          if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
          setCurrentPlayback({
            activeId: item.id,
            phaseName: t(`فاصل بين تكرارات النداء (${item.mainGap} ثانية)`, `Gap between repeats (${item.mainGap} seconds)`),
            repeatIndex: r + 1,
            totalRepeats: mainReps,
            isPaused: false
          });
          await delay(item.mainGap * 1000);
        }
      }

      // Gap before end chime
      const endGap = Math.max(0, item.afterGap ?? 1);
      if (endGap > 0) {
        if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
        setCurrentPlayback({
          activeId: item.id,
          phaseName: t(`فاصل قبل صوت النهاية (${endGap} ثانية)`, `Gap before the end chime (${endGap} seconds)`),
          repeatIndex: 1,
          totalRepeats: 1,
          isPaused: false
        });
        await delay(endGap * 1000);
      }

      // 4. Part 3: End Alert Chime (Identical to Start Chime)
      if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
      setCurrentPlayback({
        activeId: item.id,
        phaseName: t(`الجزء 3: صوت تنبيه النهاية (Alert Chime)`, `Part 3: end alert chime`),
        repeatIndex: 1,
        totalRepeats: 1,
        isPaused: false
      });
      await playPartWithFade(chimeBlob, item.afterVolume ?? item.beforeVolume ?? 80, item.afterFadeIn ?? 0, item.afterFadeOut ?? 0, currentGen);

      if (isScheduled) {
        addLogEntry({
          id: logId,
          announcementId: item.id,
          name: item.name,
          date: nowStamp.toISOString().slice(0, 10),
          scheduledTime: nowStamp.toTimeString().slice(0, 5),
          actualStartTime: nowStamp.toISOString(),
          actualEndTime: new Date().toISOString(),
          status: 'مكتمل'
        });
      }
      setCurrentPlayback(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'cancelled') {
        if (isScheduled) {
          addLogEntry({
            id: logId,
            announcementId: item.id,
            name: item.name,
            date: nowStamp.toISOString().slice(0, 10),
            scheduledTime: nowStamp.toTimeString().slice(0, 5),
            status: 'متوقف'
          });
        }
      } else {
        const isAutoplayBlocked = msg.includes('user gesture') || msg.includes('NotAllowedError');
        const displayError = isAutoplayBlocked
          ? t('المتصفح منع تشغيل النداء المجدول. اضغط «تفعيل الصوت» مرة أخرى وأبقِ هذه الصفحة مفتوحة وفي الواجهة. لا يضمن المتصفح تشغيل الصوت عند إغلاق الصفحة أو إيقافها بالخلفية.', 'The browser blocked the scheduled announcement. Press "Enable audio" again and keep this page open and in the foreground. The browser does not guarantee playback after the page is closed or sent to the background.')
          : msg;

        if (isAutoplayBlocked) {
          audioUnlocker.markPlaybackBlocked();
          setIsAudioUnlocked(false);
        }

        if (isScheduled) {
          addLogEntry({
            id: logId,
            announcementId: item.id,
            name: item.name,
            date: nowStamp.toISOString().slice(0, 10),
            scheduledTime: nowStamp.toTimeString().slice(0, 5),
            status: 'فشل التشغيل',
            error: displayError
          });
        }
        setStatusMessage({ text: displayError, type: 'error' });
      }
      setCurrentPlayback(null);
    } finally {
      // Restore background music
      if (typeof window !== 'undefined') {
        dispatchSpeechActivity({ id: item.id, active: false });
      }
    }
  };

  // Preview runner (manual, lower priority than scheduled)
  const triggerPreview = (item: Announcement) => {
    void audioUnlocker.unlock();
    void audioQueue.enqueue(() => executeSequence(item, false), true);
  };

  // Playback manual controls
  const handlePause = () => {
    if (activeAudioElement.current && !activeAudioElement.current.paused) {
      activeAudioElement.current.pause();
      setCurrentPlayback(prev => (prev ? { ...prev, isPaused: true } : null));
    }
  };

  const handleResume = () => {
    if (activeAudioElement.current && activeAudioElement.current.paused) {
      void activeAudioElement.current.play();
      setCurrentPlayback(prev => (prev ? { ...prev, isPaused: false } : null));
    }
  };

  const handleStop = () => {
    playbackGeneration.current++;
    if (activeAudioElement.current) {
      activeAudioElement.current.pause();
      activeAudioElement.current = null;
    }
    audioQueue.cancelCurrent();
    setCurrentPlayback(null);
    if (typeof window !== 'undefined') {
      try {
        const winHost = (window as unknown as { chrome?: { webview?: { postMessage: (msg: unknown) => void } } }).chrome?.webview;
        winHost?.postMessage({ type: 'gymos-desktop', action: 'announcementStop' });
      } catch {}
      dispatchSpeechActivity({ id: '*', active: false });
    }
  };

  const executeSequenceRef = useRef(executeSequence);
  useEffect(() => {
    executeSequenceRef.current = executeSequence;
  });

  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Scheduled timer polling every second (continuous background scheduler)
  useEffect(() => {
    // Windows and iOS own the schedule in their native hosts. Running this
    // browser timer too would play the same occurrence twice.
    const nativeHost = window as unknown as {
      chrome?: { webview?: { postMessage?: (message: unknown) => void } };
      GymOSAndroid?: { syncAnnouncements?: (json: string) => void };
      webkit?: { messageHandlers?: { gymosAnnouncementBridge?: unknown } };
    };
    if (!shouldRunBrowserAnnouncementScheduler({
      windows: Boolean(nativeHost.chrome?.webview?.postMessage),
      androidBridge: Boolean(nativeHost.GymOSAndroid?.syncAnnouncements),
      ios: Boolean(nativeHost.webkit?.messageHandlers?.gymosAnnouncementBridge),
      userAgent: navigator.userAgent
    })) return;
    lastScheduleTick.current = Date.now();
    const interval = setInterval(() => {
      const now = new Date();
      // A throttled background timer can miss the whole scheduled minute.
      // Recover the previous minute only while it is still reasonably recent.
      const samples = scheduledMinuteSamples(lastScheduleTick.current, now);
      lastScheduleTick.current = now.getTime();

      for (const scheduledAt of samples) {
      const wallClock = scheduledWallClockParts(scheduledAt, timezoneRef.current);
      if (!wallClock) continue;
      const todayIndex = wallClock.weekday;
      const todayDate = wallClock.date;
      const currentTime = wallClock.time;

      const dueItems = itemsRef.current.filter(item => {
        if (!item.enabled || !item.main) return false;

        const matchesTime = (item.times || []).some(t => normalizeTimeStr(t) === currentTime);
        if (!matchesTime) return false;

        const occurrenceKey = `${item.id}|${todayDate}|${currentTime}`;
        if (firedOccurrences.current.has(occurrenceKey)) return false;

        if (item.startDate && todayDate < item.startDate) return false;
        if (item.endDate && todayDate > item.endDate) return false;

        if (item.schedule === 'daily') return true;
        if (item.schedule === 'weekly') return (item.days || []).includes(todayIndex);
        if (item.schedule === 'once') return (item.date ?? item.startDate) === todayDate;
        if (item.schedule === 'interval') {
          const startMs = Date.parse((item.startDate ?? todayDate) + 'T12:00:00Z');
          const currentMs = Date.parse(todayDate + 'T12:00:00Z');
          const diffDays = Math.round((currentMs - startMs) / 86400000);
          return diffDays >= 0 && diffDays % Math.max(1, item.interval || 1) === 0;
        }
        return false;
      });

      dueItems.forEach(due => {
        const key = `${due.id}|${todayDate}|${currentTime}`;
        firedOccurrences.current.add(key);
        // Broadcast to other tabs to deduplicate
        audioUnlocker.broadcast({
          type: 'ANNOUNCEMENT_FIRED',
          occurrenceKey: key,
          id: due.id
        });
        void audioQueue.enqueue(() => executeSequenceRef.current(due, true), false);
      });
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Form helpers
  const handleUpdateEditing = <K extends keyof Announcement>(field: K, val: Announcement[K]) => {
    setEditing(prev => (prev ? { ...prev, [field]: val } : null));
  };

  // Synchronize alert chime to both start and end
  const handleSetChime = (part: AudioPart | undefined) => {
    setEditing(prev => {
      if (!prev) return null;
      return {
        ...prev,
        before: part,
        after: part,
        beforeEnabled: Boolean(part),
        afterEnabled: Boolean(part)
      };
    });
  };

  const handleFileUpload = async (field: 'main' | 'chime', file: File) => {
    if (!file) return;
    try {
      const dur = await probeAudioDuration(file);
      const part: AudioPart = {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        duration: dur,
        blob: file
      };
      await persistBlob(part);

      if (field === 'main') {
        handleUpdateEditing('main', part);
        setStatusMessage({ text: t(`تم رفع ملف النداء (${file.name}) بمدة ${dur.toFixed(1)} ثانية بنجاح.`, `Announcement file (${file.name}) uploaded successfully, ${dur.toFixed(1)} seconds.`), type: 'success' });
      } else {
        handleSetChime(part);
        setStatusMessage({ text: t(`تم اعتماد صوت التنبيه (${file.name}) للبداية والنهاية بنجاح.`, `Alert chime (${file.name}) set for the start and end.`), type: 'success' });
      }
    } catch {
      setStatusMessage({ text: t('فشل رفع وتخزين الملف الصوتي.', 'Failed to upload and store the audio file.'), type: 'error' });
    }
  };

  const handleAddTime = (val?: string) => {
    if (!editing) return;
    const target = (val ?? timeInput).trim();
    if (!target) return;
    const match = target.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
      setStatusMessage({ text: t('يرجى إدخال وقت صحيح بصيغة 24 ساعة (مثال: 08:30 أو 15:45)', 'Please enter a valid 24-hour time (for example 08:30 or 15:45)'), type: 'error' });
      return;
    }
    const formatted = `${match[1].padStart(2, '0')}:${match[2]}`;
    if (!editing.times.map(normalizeTimeStr).includes(formatted)) {
      handleUpdateEditing('times', [...editing.times, formatted].sort());
      setTimeInput('');
      setStatusMessage({ text: t(`تمت إضافة الموعد: ${formatted}`, `Time added: ${formatted}`), type: 'info' });
    } else {
      setTimeInput('');
    }
  };

  const handleSave = async () => {
    if (!editing) return;

    const finalTimes = [...editing.times];
    if (timeInput.trim()) {
      const match = timeInput.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (match) {
        const formatted = `${match[1].padStart(2, '0')}:${match[2]}`;
        if (!finalTimes.map(normalizeTimeStr).includes(formatted)) {
          finalTimes.push(formatted);
          finalTimes.sort();
        }
      }
    }

    if (!editing.name.trim()) {
      setStatusMessage({ text: t('يرجى إدخال اسم النداء أولاً.', 'Please enter the announcement name first.'), type: 'error' });
      return;
    }
    if (!editing.main || !editing.main.id) {
      setStatusMessage({ text: t('يرجى رفع ملف النداء الأساسي الإلزامي.', 'Please upload the required main announcement file.'), type: 'error' });
      return;
    }
    if (finalTimes.length === 0) {
      setStatusMessage({ text: t('يرجى تحديد موعد تشغيل واحد على الأقل.', 'Please choose at least one play time.'), type: 'error' });
      return;
    }

    // Strict 30-second sequence validation
    const validation = validateAnnouncementSequence(editing);
    if (validation.exceedsLimit) {
      setStatusMessage({
        text: t(`غير مسموح بالحفظ: ${validation.error} الحد الأقصى الإلزامي لكل نداء (صوت التنبيه + النداء + صوت النهاية) هو أقل من 30 ثانية لضمان عمل الإشعارات والجدولة بدقة على جميع الأنظمة.`, `Cannot save: ${validation.error} The maximum for each announcement (chime + announcement + end chime) is under 30 seconds so notifications and scheduling work reliably on all platforms.`),
        type: 'error'
      });
      return;
    }

    // Pre-compose 3-part sequence if possible
    let composedId: string | undefined;
    try {
      const mainBlob = await retrieveBlob(editing.main.id);
      const chimeBlob = await retrieveBlob(editing.before?.id || DEFAULT_CHIME_PART.id);
      if (mainBlob && chimeBlob) {
        const comp = await composeAnnouncementAudio(
          {
            id: editing.id,
            name: editing.name,
            main: editing.main,
            mainVolume: editing.mainVolume,
            chime: editing.before,
            chimeVolume: editing.beforeVolume,
            chimeGap: editing.beforeGap
          },
          chimeBlob,
          mainBlob
        );
        if (comp.wavBlob && !comp.exceedsLimit) {
          composedId = `comp_${editing.id}`;
          await persistBlob({
            id: composedId,
            name: `${editing.name} (Composed)`,
            size: comp.wavBlob.size,
            duration: comp.durationSeconds,
            blob: comp.wavBlob
          });
        }
      }
    } catch {
      // Fallback to sequential runtime playback
    }

    const toSave: Announcement = {
      ...editing,
      // Ensure end chime strictly mirrors start chime
      after: editing.before,
      afterEnabled: editing.beforeEnabled,
      afterVolume: editing.beforeVolume,
      afterGap: editing.afterGap ?? editing.beforeGap ?? 1,
      times: finalTimes,
      composedId,
      totalDurationSeconds: validation.totalSeconds
    };

    const exists = items.some(x => x.id === toSave.id);
    const updated = exists ? items.map(x => (x.id === toSave.id ? toSave : x)) : [...items, toSave];
    saveToStorage(updated);
    setEditing(null);
    setTimeInput('');
    setStatusMessage({
      text: t(`تم حفظ النداء وجدولته بنجاح (المدة الإجمالية: ${validation.totalSeconds} ثانية < 30.0s).`, `Announcement saved and scheduled (total duration: ${validation.totalSeconds} seconds, under 30.0s).`),
      type: 'success'
    });
  };

  const handleDelete = async (item: Announcement) => {
    if (!await confirm({ title: t(`هل أنت متأكد من حذف النداء "${item.name}" بالكامل؟`, `Delete the announcement "${item.name}" completely?`) })) return;
    const remaining = items.filter(x => x.id !== item.id);
    saveToStorage(remaining);

    // Clean unreferenced blobs
    const usedIds = new Set<string>();
    remaining.forEach(r => {
      if (r.main?.id) usedIds.add(r.main.id);
      if (r.before?.id) usedIds.add(r.before.id);
      if (r.after?.id) usedIds.add(r.after.id);
      if (r.composedId) usedIds.add(r.composedId);
    });

    const toDelete: string[] = [];
    if (item.main?.id && !usedIds.has(item.main.id)) toDelete.push(item.main.id);
    if (item.before?.id && !usedIds.has(item.before.id)) toDelete.push(item.before.id);
    if (item.after?.id && !usedIds.has(item.after.id)) toDelete.push(item.after.id);
    if (item.composedId && !usedIds.has(item.composedId)) toDelete.push(item.composedId);

    if (toDelete.length) await deleteBlobs(toDelete);
    setStatusMessage({ text: t('تم حذف النداء وتنظيف الملفات غير المستخدمة.', 'The announcement was deleted and unused files were cleaned up.'), type: 'info' });
  };

  const handleRemoveTime = (t: string) => {
    if (!editing) return;
    handleUpdateEditing('times', editing.times.filter(x => x !== t));
  };

  // Timeline preview calculation for the editing item
  const timelineInfo = editing && editing.main ? calculateTimeline(editing) : null;
  const isOverDurationLimit = (timelineInfo?.totalSeconds ?? 0) >= MAX_ANNOUNCEMENT_DURATION_SECONDS;

  return (
    <section className="announcements-page" hidden={!visible} dir={ar ? 'rtl' : 'ltr'}>
      {/* Page Header */}
      <div className="section-head">
        <div>
          <span className="eyebrow">SCHEDULED ANNOUNCEMENTS SYSTEM</span>
          <h1>{t('إدارة النداءات الصوتية المجدولة', 'Scheduled voice announcements')}</h1>
          <p>
            {ar ? (
              <>
                نظام موحد متعدد المنصات (Web و Windows و Android و iOS) لتشغيل النداءات وفق تسلسل إجباري متسق:{' '}
                <strong>صوت التنبيه (Alert Chime) ➔ النداء الصوتي ➔ صوت التنبيه</strong> بإجمالي مدة أقل من 30 ثانية.
              </>
            ) : (
              <>
                One system for Web, Windows, Android and iOS that plays announcements in a fixed order:{' '}
                <strong>Alert chime ➔ Voice announcement ➔ Alert chime</strong>, under 30 seconds in total.
              </>
            )}
          </p>
        </div>
        <button className="button primary" onClick={() => setEditing(blankAnnouncement())}>
          <Plus data-icon="inline-start" /> {t('إضافة نداء جديد', 'Add announcement')}
        </button>
      </div>

      {/* Browser Autoplay / Audio Unlock Banner */}
      <div
        className="card"
        style={{
          margin: '1rem 0',
          padding: '1rem 1.25rem',
          border: isNativeAudioHost || isAudioUnlocked ? '1px solid #16a34a' : '2px solid #eab308',
          background: isNativeAudioHost || isAudioUnlocked ? 'rgba(22, 163, 74, 0.08)' : 'rgba(234, 179, 8, 0.12)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {isNativeAudioHost || isAudioUnlocked ? (
            <CheckCircle size={24} style={{ color: '#22c55e', flexShrink: 0 }} />
          ) : (
            <AlertTriangle size={24} style={{ color: '#eab308', flexShrink: 0 }} />
          )}
          <div>
            <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 'bold' }}>
              {isNativeAudioHost
                ? t('مُجدول الصوت الأصلي مفعّل في الخلفية', 'Native background audio scheduler active')
                : isAudioUnlocked
                  ? t('الصوت مسموح في هذه الجلسة', 'Audio is allowed in this session')
                  : t('تفعيل الصوت لهذه الجلسة', 'Enable audio for this session')}
            </h4>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#cbd5e1' }}>
              {isNativeAudioHost
                ? t('التطبيق يدير النداءات الصوتية تلقائيًا على مستوى النظام، ويستمر التشغيل في الخلفية حتى عند إغلاق النافذة.', 'The app manages voice announcements natively at the system level and keeps playing in the background even when minimized or closed to tray.')
                : isAudioUnlocked
                  ? t('تم السماح بالصوت في الجلسة الحالية فقط. اترك الصفحة مفتوحة وفي الواجهة؛ لا يمكن ضمان التشغيل إذا أوقف المتصفح الصفحة بالخلفية.', 'Audio is allowed for the current session only. Leave the page open and in the foreground; playback cannot be guaranteed if the browser pauses the page in the background.')
                  : t('اضغط الزر لتجربة تفعيل الصوت في هذه الجلسة. المتصفح قد يمنع النداء المجدول، ولا يضمن التشغيل بعد إغلاق الصفحة أو إيقافها بالخلفية.', 'Press the button to enable audio in this session. The browser may block the scheduled announcement and does not guarantee playback after the page is closed or sent to the background.')}
            </p>
          </div>
        </div>
        {!isNativeAudioHost && !isAudioUnlocked && (
          <button
            type="button"
            className="button primary"
            onClick={() => void handleUnlockAudio()}
            style={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <ShieldCheck size={18} /> {t('تفعيل الصوت التلقائي للنداءات', 'Enable automatic audio for announcements')}
          </button>
        )}
      </div>

      {statusMessage && (
        <div
          className={`notification ${statusMessage.type === 'error' ? 'alert' : 'card'}`}
          style={{
            margin: '1rem 0',
            borderRight: statusMessage.type === 'error' ? '4px solid #ef4444' : '4px solid #22c55e'
          }}
          role="status"
        >
          <p>{statusMessage.text}</p>
        </div>
      )}

      {/* Floating Active Playback Controls Bar */}
      {currentPlayback && (
        <div
          className="card active-playback-bar"
          style={{ border: '2px solid var(--accent, #eab308)', margin: '1rem 0', background: 'rgba(234, 179, 8, 0.1)' }}
        >
          <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span className="badge" style={{ backgroundColor: '#eab308', color: '#000', fontWeight: 'bold' }}>
                {t('جاري البث الصوتي', 'Playing now')}
              </span>
              <h3 style={{ margin: '0.25rem 0 0' }}>{currentPlayback.phaseName}</h3>
            </div>
            <div className="actions" style={{ display: 'flex', gap: '0.5rem' }}>
              {currentPlayback.isPaused ? (
                <button className="button primary" onClick={handleResume}>
                  <Play data-icon="inline-start" /> {t('استكمال', 'Resume')}
                </button>
              ) : (
                <button className="button secondary" onClick={handlePause}>
                  <Pause data-icon="inline-start" /> {t('إيقاف مؤقت', 'Pause')}
                </button>
              )}
              <button className="button secondary" onClick={handleStop} style={{ color: '#ef4444' }}>
                <Square data-icon="inline-start" /> {t('إيقاف نهائي', 'Stop')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Form Modal/Card */}
      {editing && (
        <section className="card announcement-form" style={{ marginTop: '1.5rem', padding: '1.5rem', border: '1px solid #334155' }}>
          <div className="card-head">
            <div>
              <h2>{items.some(x => x.id === editing.id) ? t('تعديل النداء الصوتي', 'Edit voice announcement') : t('إضافة نداء صوتي جديد', 'Add a new voice announcement')}</h2>
              <p style={{ color: '#94a3b8' }}>
                {ar ? (
                  <>الترتيب الإجباري الموحد: <strong>صوت التنبيه ➔ النداء الأساسي ➔ صوت التنبيه</strong> (إجمالي المدة &lt; 30 ثانية).</>
                ) : (
                  <>Fixed order: <strong>Alert chime ➔ Main announcement ➔ Alert chime</strong> (total duration &lt; 30 seconds).</>
                )}
              </p>
            </div>
            <button className="text-button" onClick={() => setEditing(null)}>
              {t('إلغاء', 'Cancel')}
            </button>
          </div>

          {/* Section 1: Name */}
          <div className="form-group" style={{ margin: '1rem 0' }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' }}>
              {t('اسم النداء', 'Announcement name')} <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              type="text"
              value={editing.name}
              onChange={e => handleUpdateEditing('name', e.target.value)}
              placeholder={t('مثال: تنبيه مواعيد إغلاق الصالة، تذكير الصلاة، بداية الحصة...', 'Example: gym closing reminder, prayer reminder, class start...')}
              style={{ width: '100%', boxSizing: 'border-box', padding: '0.75rem', borderRadius: '6px', border: '1px solid #ccc' }}
              required
            />
          </div>

          <div
            className="dashboard-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1rem', marginTop: '1rem' }}
          >
            {/* Unified Alert Chime Section (Start & End) */}
            <div className="card" style={{ padding: '1.25rem', background: 'var(--card-bg, #1e293b)' }}>
              <div className="card-head">
                <h3>
                  <Music size={18} /> {t('نغمة التنبيه (Alert Chime)', 'Alert chime')}
                </h3>
                <span className="badge" style={{ background: '#3b82f6', color: '#fff' }}>
                  {t('البداية والنهاية', 'Start and end')}
                </span>
              </div>
              <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: '0.5rem 0' }}>
                {t('نفس نغمة التنبيه يتم تشغيلها في البداية والنهاية تلقائيًا لمنع أي تشويش وضمان التوافق مع أنظمة الإشعارات المدمجة.', 'The same chime plays automatically at the start and the end to avoid any confusion and to stay compatible with built-in notification systems.')}
              </p>

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', margin: '0.75rem 0' }}>
                <label className="button secondary" style={{ display: 'inline-block', cursor: 'pointer' }}>
                  <Upload size={16} /> {t('رفع نغمة مخصصة (WAV/MP3)', 'Upload a custom chime (WAV/MP3)')}
                  <input
                    type="file"
                    accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav"
                    hidden
                    onChange={e => e.target.files?.[0] && void handleFileUpload('chime', e.target.files[0])}
                  />
                </label>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => handleSetChime({ ...DEFAULT_CHIME_PART })}
                >
                  {t('استعادة النغمة الافتراضية', 'Restore default chime')}
                </button>
              </div>

              {editing.before && (
                <div style={{ fontSize: '0.875rem', margin: '0.5rem 0', background: 'rgba(255,255,255,0.05)', padding: '0.5rem', borderRadius: '4px' }}>
                  <p>
                    <strong>{t('اسم النغمة:', 'Chime name:')}</strong> {chimeName(editing.before.name)}
                  </p>
                  <p>
                    <strong>{t('المدة:', 'Duration:')}</strong> {editing.before.duration ? t(`${editing.before.duration.toFixed(1)} ثانية`, `${editing.before.duration.toFixed(1)} seconds`) : t('غير محدد', 'Not set')}
                  </p>
                </div>
              )}

              <label style={{ display: 'block', margin: '0.75rem 0' }}>
                {t('مستوى صوت نغمة التنبيه:', 'Alert chime volume:')} {editing.beforeVolume}%
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={editing.beforeVolume}
                  onChange={e => {
                    const vol = Number(e.target.value);
                    handleUpdateEditing('beforeVolume', vol);
                    handleUpdateEditing('afterVolume', vol);
                  }}
                  style={{ width: '100%' }}
                />
              </label>

              <div style={{ display: 'flex', gap: '0.5rem', margin: '0.75rem 0' }}>
                <label style={{ flex: 1 }}>
                  {t('فاصل بعد نغمة البداية:', 'Gap after the start chime:')}
                  <select
                    value={editing.beforeGap}
                    onChange={e => handleUpdateEditing('beforeGap', Number(e.target.value))}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                  >
                    <option value={0.5}>{t('0.5 ثانية', '0.5 seconds')}</option>
                    <option value={1}>{t('ثانية واحدة', '1 second')}</option>
                    <option value={2}>{t('ثانيتان', '2 seconds')}</option>
                    <option value={3}>{t('3 ثوانٍ', '3 seconds')}</option>
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  {t('فاصل قبل نغمة النهاية:', 'Gap before the end chime:')}
                  <select
                    value={editing.afterGap}
                    onChange={e => handleUpdateEditing('afterGap', Number(e.target.value))}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                  >
                    <option value={0.5}>{t('0.5 ثانية', '0.5 seconds')}</option>
                    <option value={1}>{t('ثانية واحدة', '1 second')}</option>
                    <option value={2}>{t('ثانيتان', '2 seconds')}</option>
                    <option value={3}>{t('3 ثوانٍ', '3 seconds')}</option>
                  </select>
                </label>
              </div>
            </div>

            {/* Main Announcement Section (Mandatory) */}
            <div className="card" style={{ padding: '1.25rem', border: '1px solid var(--accent, #eab308)' }}>
              <div className="card-head">
                <h3>
                  <Volume2 size={18} /> {t('ملف النداء الصوتي الأساسي', 'Main announcement audio file')} <span style={{ color: '#ef4444' }}>*</span>
                </h3>
              </div>
              <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: '0.5rem 0' }}>
                {t('صوت الرسالة الأساسية الموجهة للمتدربين بالصالة (بصيغة WAV أو MP3).', 'The main message for gym members (WAV or MP3).')}
              </p>

              <label className="button primary" style={{ display: 'inline-block', margin: '0.5rem 0', cursor: 'pointer' }}>
                <Upload size={16} /> {editing.main ? t('استبدال ملف النداء', 'Replace announcement file') : t('رفع ملف النداء الأساسي', 'Upload main announcement file')}
                <input
                  type="file"
                  accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav"
                  hidden
                  onChange={e => e.target.files?.[0] && void handleFileUpload('main', e.target.files[0])}
                />
              </label>

              <VoxStudioPanel
                owner={owner}
                ar={ar}
                onAudioGenerated={file => handleFileUpload('main', file)}
              />

              {editing.main ? (
                <div
                  style={{
                    fontSize: '0.875rem',
                    margin: '0.5rem 0',
                    background: 'rgba(255,255,255,0.05)',
                    padding: '0.5rem',
                    borderRadius: '4px'
                  }}
                >
                  <p>
                    <strong>{t('اسم الملف:', 'File name:')}</strong> {editing.main.name}
                  </p>
                  <p>
                    <strong>{t('مدة التسجيل:', 'Recording length:')}</strong> {editing.main.duration ? t(`${editing.main.duration.toFixed(1)} ثانية`, `${editing.main.duration.toFixed(1)} seconds`) : t('غير محدد', 'Not set')}
                  </p>
                  <p>
                    <strong>{t('الحجم:', 'Size:')}</strong> {(editing.main.size / (1024 * 1024)).toFixed(2)} MB
                  </p>
                </div>
              ) : (
                <p style={{ color: '#f87171', fontSize: '0.85rem' }}>{t('يجب رفع ملف صوتي أساسي لحفظ النداء.', 'A main audio file is required to save the announcement.')}</p>
              )}

              <label style={{ display: 'block', margin: '0.75rem 0' }}>
                {t('مستوى الصوت الأساسي:', 'Main volume:')} {editing.mainVolume}%
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={editing.mainVolume}
                  onChange={e => handleUpdateEditing('mainVolume', Number(e.target.value))}
                  style={{ width: '100%' }}
                />
              </label>

              <div style={{ display: 'flex', gap: '0.5rem', margin: '0.75rem 0' }}>
                <label style={{ flex: 1 }}>
                  {t('تكرار النداء:', 'Repeat announcement:')}
                  <select
                    value={editing.mainRepeats}
                    onChange={e => handleUpdateEditing('mainRepeats', Number(e.target.value))}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                  >
                    <option value={1}>{t('مرة واحدة', 'Once')}</option>
                    <option value={2}>{t('مرتان', 'Twice')}</option>
                  </select>
                </label>
                {editing.mainRepeats > 1 && (
                  <label style={{ flex: 1 }}>
                    {t('الفاصل بين التكرار:', 'Gap between repeats:')}
                    <select
                      value={editing.mainGap}
                      onChange={e => handleUpdateEditing('mainGap', Number(e.target.value))}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                    >
                      <option value={1}>{t('ثانية واحدة', '1 second')}</option>
                      <option value={2}>{t('ثانيتان', '2 seconds')}</option>
                      <option value={3}>{t('3 ثوانٍ', '3 seconds')}</option>
                    </select>
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* Sequence Duration Meter (Mandatory < 30.0s Limit) */}
          {timelineInfo && (
            <div
              style={{
                marginTop: '1.25rem',
                padding: '1rem',
                borderRadius: '8px',
                border: isOverDurationLimit ? '2px solid #ef4444' : '1px solid #16a34a',
                background: isOverDurationLimit ? 'rgba(239, 68, 68, 0.12)' : 'rgba(22, 163, 74, 0.1)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {isOverDurationLimit ? (
                    <AlertTriangle size={20} style={{ color: '#ef4444' }} />
                  ) : (
                    <CheckCircle size={20} style={{ color: '#22c55e' }} />
                  )}
                  <strong>
                    {t('إجمالي مدة التسلسل الثلاثي (تنبيه ➔ نداء ➔ تنبيه):', 'Total sequence length (chime ➔ announcement ➔ chime):')}{' '}
                    <span style={{ color: isOverDurationLimit ? '#ef4444' : '#22c55e', fontSize: '1.1rem' }}>
                      {timelineInfo.totalSeconds.toFixed(1)} {t('ثانية', 'seconds')}
                    </span>
                  </strong>
                </div>
                <span className="badge" style={{ background: isOverDurationLimit ? '#ef4444' : '#22c55e', color: '#fff' }}>
                  {t('الحد الأقصى: 30.0 ثانية', 'Maximum: 30.0 seconds')}
                </span>
              </div>

              {/* Progress bar */}
              <div style={{ width: '100%', height: '8px', background: '#334155', borderRadius: '4px', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, (timelineInfo.totalSeconds / MAX_ANNOUNCEMENT_DURATION_SECONDS) * 100)}%`,
                    backgroundColor: isOverDurationLimit ? '#ef4444' : timelineInfo.totalSeconds > 25 ? '#eab308' : '#22c55e',
                    transition: 'width 0.3s ease'
                  }}
                />
              </div>

              {isOverDurationLimit ? (
                <p style={{ margin: '0.5rem 0 0', color: '#ef4444', fontSize: '0.85rem', fontWeight: 'bold' }}>
                  {t(
                    '⚠️ تنبيه إلزامي: مدة النداء تتجاوز 30 ثانية. يرجى تقليص مدة التسجيل الصوتي أو الفواصل الزمنية لتتمكن من حفظ النداء (الحد مطلوب لضمان عمل الإشعارات الصوتية المجدولة بدقة على Windows و Android و iOS).',
                    '⚠️ Required: the announcement is longer than 30 seconds. Shorten the recording or the gaps so you can save it (the limit keeps scheduled audio notifications reliable on Windows, Android and iOS).'
                  )}
                </p>
              ) : (
                <p style={{ margin: '0.5rem 0 0', color: '#86efac', fontSize: '0.85rem' }}>
                  {t('✓ المدة متوافقة تماماً مع معايير الجدولة الموحدة لكل المنصات.', '✓ The duration meets the shared scheduling limits on all platforms.')}
                </p>
              )}
            </div>
          )}

          {/* Section 5: Scheduling Settings */}
          <div className="card" style={{ marginTop: '1rem', padding: '1.25rem' }}>
            <h3>
              <Calendar size={18} /> {t('جدولة النداء وتحديد أوقات البث', 'Schedule and broadcast times')}
            </h3>
            <div className="form-row" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '1rem 0' }}>
              <label style={{ flex: 1, minWidth: '200px' }}>
                {t('نوع الجدولة:', 'Schedule type:')}
                <select
                  value={editing.schedule}
                  onChange={e => handleUpdateEditing('schedule', e.target.value as Announcement['schedule'])}
                  style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                >
                  <option value="daily">{t('يوميًا', 'Daily')}</option>
                  <option value="weekly">{t('أيام محددة أسبوعيًا', 'Specific weekdays')}</option>
                  <option value="once">{t('يوم واحد فقط', 'One day only')}</option>
                  <option value="interval">{t('كل عدد معين من الأيام', 'Every N days')}</option>
                </select>
              </label>

              <label style={{ flex: 1, minWidth: '200px' }}>
                {t('تاريخ البداية:', 'Start date:')}
                <input
                  type="date"
                  value={editing.startDate}
                  onChange={e => handleUpdateEditing('startDate', e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                />
              </label>

              <label style={{ flex: 1, minWidth: '200px' }}>
                {t('تاريخ النهاية (اختياري):', 'End date (optional):')}
                <input
                  type="date"
                  value={editing.endDate ?? ''}
                  onChange={e => handleUpdateEditing('endDate', e.target.value || undefined)}
                  style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                />
              </label>
            </div>

            {/* Weekly Days Selector */}
            {editing.schedule === 'weekly' && (
              <div style={{ margin: '1rem 0' }}>
                <p style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>{t('الأيام المحددة أسبوعيًا:', 'Weekdays:')}</p>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {DAYS_NAMES.map((arName, idx) => { const name = ar ? arName : DAYS_NAMES_EN[idx]; return (
                    <button
                      type="button"
                      key={arName}
                      className={editing.days.includes(idx) ? 'button primary' : 'button secondary'}
                      onClick={() => {
                        const next = editing.days.includes(idx)
                          ? editing.days.filter(x => x !== idx)
                          : [...editing.days, idx];
                        handleUpdateEditing('days', next);
                      }}
                    >
                      {name}
                    </button>
                  ); })}
                </div>
              </div>
            )}

            {/* Single Date Selector */}
            {editing.schedule === 'once' && (
              <div style={{ margin: '1rem 0' }}>
                <label>
                  {t('تاريخ التشغيل:', 'Play date:')}
                  <input
                    type="date"
                    value={editing.date ?? editing.startDate}
                    onChange={e => handleUpdateEditing('date', e.target.value)}
                    style={{ padding: '0.5rem', marginRight: '0.5rem' }}
                  />
                </label>
              </div>
            )}

            {/* Interval Days Selector */}
            {editing.schedule === 'interval' && (
              <div style={{ margin: '1rem 0' }}>
                <label>
                  {t('التشغيل كل عدد من الأيام:', 'Play every N days:')}
                  <select
                    value={editing.interval}
                    onChange={e => handleUpdateEditing('interval', Number(e.target.value))}
                    style={{ padding: '0.5rem', marginRight: '0.5rem' }}
                  >
                    <option value={2}>{t('كل يومين', 'Every 2 days')}</option>
                    <option value={3}>{t('كل 3 أيام', 'Every 3 days')}</option>
                    <option value={4}>{t('كل 4 أيام', 'Every 4 days')}</option>
                    <option value={5}>{t('كل 5 أيام', 'Every 5 days')}</option>
                    <option value={7}>{t('كل 7 أيام', 'Every 7 days')}</option>
                  </select>
                </label>
              </div>
            )}

            {/* Times Selector (Multiple Times Supported) */}
            <div style={{ margin: '1rem 0' }}>
              <p style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>{t('أوقات التشغيل (ساعات ودقائق):', 'Play times (hours and minutes):')}</p>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                <input
                  type="time"
                  value={timeInput}
                  onChange={e => setTimeInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTime();
                    }
                  }}
                  style={{ padding: '0.5rem' }}
                />
                <button type="button" className="button secondary" onClick={() => handleAddTime()}>
                  {t('+ إضافة موعد', '+ Add time')}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  style={{ fontSize: '0.8rem' }}
                  onClick={() => handleAddTime(getLocalTimeStr())}
                >
                  {t('موعد الآن', 'Time now')} ({getLocalTimeStr()})
                </button>
              </div>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8', alignSelf: 'center' }}>{t('مواعيد مقترحة:', 'Suggested times:')}</span>
                {['09:00', '12:00', '15:00', '18:00', '21:00'].map(preset => (
                  <button
                    key={preset}
                    type="button"
                    className="button secondary"
                    style={{ padding: '0.15rem 0.45rem', fontSize: '0.78rem' }}
                    onClick={() => handleAddTime(preset)}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {editing.times.map(t => (
                  <span
                    key={t}
                    className="badge"
                    style={{
                      padding: '0.4rem 0.8rem',
                      background: '#334155',
                      color: '#fff',
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}
                  >
                    <Clock size={14} /> {t}
                    <button
                      type="button"
                      onClick={() => handleRemoveTime(t)}
                      style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontWeight: 'bold' }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Form Actions */}
          <div className="card-head" style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button
                className="button primary"
                disabled={isOverDurationLimit}
                onClick={() => void handleSave()}
                style={{ opacity: isOverDurationLimit ? 0.5 : 1, cursor: isOverDurationLimit ? 'not-allowed' : 'pointer' }}
              >
                {t('حفظ وجدولة النداء', 'Save and schedule announcement')}
              </button>
              <button className="button secondary" onClick={() => triggerPreview(editing)}>
                <Play data-icon="inline-start" /> {t('تجربة التسلسل كاملًا', 'Test the full sequence')}
              </button>
            </div>
            <button className="text-button" onClick={() => setEditing(null)}>
              {t('إلغاء', 'Cancel')}
            </button>
          </div>
        </section>
      )}

      {/* List of Announcements Cards */}
      <h2 style={{ marginTop: '2rem', marginBottom: '1rem' }}>{t('قائمة النداءات المجدولة', 'Scheduled announcements')} ({items.length})</h2>
      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1rem' }}>
        {items.map(item => {
          const scheduleText =
            item.schedule === 'daily'
              ? t('يوميًا', 'Daily')
              : item.schedule === 'weekly'
              ? item.days.map(d => (ar ? DAYS_NAMES[d] : DAYS_NAMES_EN[d])).join(ar ? '، ' : ', ')
              : item.schedule === 'once'
              ? t(`تاريخ محدد: ${item.date ?? item.startDate}`, `Specific date: ${item.date ?? item.startDate}`)
              : t(`كل ${item.interval} أيام`, `Every ${item.interval} days`);

          const itemDuration = item.totalDurationSeconds ?? calculateTimeline(item).totalSeconds;

          return (
            <article className="card announcement-card" key={item.id} style={{ padding: '1rem', position: 'relative' }}>
              <div className="card-head" style={{ marginBottom: '0.75rem' }}>
                <div>
                  <h3 style={{ margin: 0 }}>{item.name}</h3>
                  <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                    {item.main.name} · {itemDuration.toFixed(1)} {t('ثانية', 'seconds')}
                  </span>
                </div>
                <button
                  className={item.enabled ? 'badge' : 'badge secondary'}
                  style={{ cursor: 'pointer', border: 'none', padding: '0.3rem 0.6rem' }}
                  onClick={() => {
                    const next = items.map(x => (x.id === item.id ? { ...x, enabled: !x.enabled } : x));
                    saveToStorage(next);
                  }}
                >
                  {item.enabled ? t('مفعل', 'Enabled') : t('معطل', 'Disabled')}
                </button>
              </div>

              <div style={{ fontSize: '0.85rem', lineHeight: '1.6', margin: '0.75rem 0' }}>
                <p>
                  <strong>{t('التسلسل الصوتي:', 'Audio sequence:')}</strong> {t('تنبيه', 'Chime')} ({chimeName(item.before?.name) ?? t('افتراضي', 'Default')}) ➔ {t('نداء', 'Announcement')} ➔ {t('تنبيه', 'Chime')}
                </p>
                <p>
                  <strong>{t('الأيام:', 'Days:')}</strong> {scheduleText}
                </p>
                <p>
                  <strong>{t('المواعيد:', 'Times:')}</strong> {item.times.join(ar ? ' ، ' : ', ')}
                </p>
              </div>

              <div
                className="card-head"
                style={{ marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.75rem' }}
              >
                <button className="button secondary" onClick={() => triggerPreview(item)}>
                  <Play size={14} /> {t('تشغيل تجريبي', 'Test play')}
                </button>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="text-button" onClick={() => setEditing(item)}>
                    {t('تعديل', 'Edit')}
                  </button>
                  <button className="text-button" onClick={() => void handleDelete(item)} style={{ color: '#f87171' }}>
                    <Trash2 size={16} /> {t('حذف', 'Delete')}
                  </button>
                </div>
              </div>
            </article>
          );
        })}

        {!items.length && (
          <div className="card empty" style={{ textAlign: 'center', padding: '2rem' }}>
            <Volume2 size={40} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
            <h3>{t('لا توجد نداءات مضافة بعد', 'No announcements yet')}</h3>
            <p>{ar ? (<>اضغط على زر <strong>+ إضافة نداء جديد</strong> لرفع ملف صوتي وتحديد أوقات تشغيله.</>) : (<>Press <strong>+ Add announcement</strong> to upload an audio file and set when it plays.</>)}</p>
          </div>
        )}
      </div>

      {/* Execution Logs Section */}
      <section className="card" style={{ marginTop: '2.5rem', padding: '1.25rem' }}>
        <div className="card-head">
          <div>
            <h2>{t('سجل تشغيل النداءات', 'Announcement play log')}</h2>
            <p>{t('سجل تفصيلي لعمليات البث المجدولة والسابقة مع حالتها التشغيلية وتفاصيل الأخطاء إن وجدت.', 'Detailed log of scheduled and past broadcasts with their status and any error details.')}</p>
          </div>
          {logs.length > 0 && (
            <button className="text-button" onClick={clearLogs}>
              {t('تنظيف السجل', 'Clear log')}
            </button>
          )}
        </div>

        {logs.length > 0 ? (
          <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
            <table style={{ width: '100%', textAlign: ar ? 'right' : 'left', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={{ padding: '0.5rem' }}>{t('اسم النداء', 'Announcement')}</th>
                  <th style={{ padding: '0.5rem' }}>{t('التاريخ', 'Date')}</th>
                  <th style={{ padding: '0.5rem' }}>{t('الموعد المجدول', 'Scheduled time')}</th>
                  <th style={{ padding: '0.5rem' }}>{t('وقت البدء الفعلي', 'Actual start')}</th>
                  <th style={{ padding: '0.5rem' }}>{t('الحالة', 'Status')}</th>
                  <th style={{ padding: '0.5rem' }}>{t('ملاحظات', 'Notes')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 30).map(log => (
                  <tr key={log.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '0.5rem', fontWeight: 'bold' }}>{log.name}</td>
                    <td style={{ padding: '0.5rem' }}>{log.date}</td>
                    <td style={{ padding: '0.5rem' }}>{log.scheduledTime}</td>
                    <td style={{ padding: '0.5rem' }}>
                      {log.actualStartTime ? new Date(log.actualStartTime).toLocaleTimeString(ar ? 'ar-EG' : 'en-GB') : '-'}
                    </td>
                    <td style={{ padding: '0.5rem' }}>
                      <span
                        className={`badge ${
                          log.status === 'مكتمل' ? 'primary' : log.status === 'فشل التشغيل' ? 'alert' : 'secondary'
                        }`}
                      >
                        {ar ? log.status : (LOG_STATUS_EN[log.status] ?? log.status)}
                      </span>
                    </td>
                    <td style={{ padding: '0.5rem', color: log.error ? '#f87171' : 'inherit' }}>
                      {log.error ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="form-note" style={{ marginTop: '1rem' }}>
            {t('لا توجد سجلات تشغيل سابقة حتى الآن.', 'No play logs yet.')}
          </p>
        )}
      </section>
      {dialog}
    </section>
  );
}
