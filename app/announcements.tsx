'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {Pause,Play,Plus,Square,Trash2,Upload,Volume2,Clock,Calendar,Music,AlertCircle,CheckCircle,RefreshCw} from 'lucide-react';
import type {GymState,Operation} from './lib/domain';
import type {Role} from './lib/access';
import {audioQueue,calculateTimeline,delay,type AudioPart,type SequenceItem} from './lib/announcement-audio';

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
};

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
        req.result.createObjectStore('audio_blobs', {keyPath: 'id'});
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
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function retrieveBlob(id: string): Promise<Blob | undefined> {
  const db = await openAudioDb();
  return new Promise<Blob | undefined>((resolve, reject) => {
    const tx = db.transaction('audio_blobs', 'readonly');
    const req = tx.objectStore('audio_blobs').get(id);
    req.onsuccess = () => { db.close(); resolve(req.result?.blob); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function deleteBlobs(ids: string[]): Promise<void> {
  const db = await openAudioDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('audio_blobs', 'readwrite');
    const store = tx.objectStore('audio_blobs');
    ids.forEach(id => store.delete(id));
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

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

export default function Announcements({
  branch,
  owner,
  ar,
  role,
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
  const [items, setItems] = useState<Announcement[]>([]);
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [timeInput, setTimeInput] = useState('');
  const [statusMessage, setStatusMessage] = useState<{text: string; type: 'success' | 'error' | 'info'} | null>(null);

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

  const blankAnnouncement = (): Announcement => ({
    id: crypto.randomUUID(),
    branch,
    name: '',
    main: null as never,
    mainVolume: 100,
    mainRepeats: 1,
    mainGap: 0,
    beforeEnabled: false,
    beforeVolume: 80,
    beforeRepeats: 1,
    beforeGap: 3,
    beforeFadeIn: 0,
    beforeFadeOut: 0,
    afterEnabled: false,
    afterVolume: 80,
    afterRepeats: 1,
    afterGap: 2,
    afterFadeIn: 0,
    afterFadeOut: 0,
    schedule: 'daily',
    days: [0, 1, 2, 3, 4, 5, 6],
    times: ['08:00'],
    startDate: new Date().toISOString().slice(0, 10),
    interval: 1,
    enabled: true,
    createdAt: new Date().toISOString()
  });

  // Load from local storage on mount/scope change
  useEffect(() => {
    if (!visible) return;
    try {
      const raw = localStorage.getItem(storageKey(scope));
      if (raw) setItems(JSON.parse(raw));
      const savedLogs = localStorage.getItem(logsKey(scope));
      if (savedLogs) setLogs(JSON.parse(savedLogs));
    } catch {
      setStatusMessage({text: 'تعذر قراءة البيانات المحفوظة محليًا.', type: 'error'});
    }
  }, [scope, visible]);

  // Persist announcements metadata to localStorage
  const saveToStorage = useCallback((updated: Announcement[]) => {
    setItems(updated);
    try {
      const stripped = updated.map(({main, before, after, ...rest}) => ({
        ...rest,
        main: {id: main.id, name: main.name, size: main.size, duration: main.duration},
        before: before ? {id: before.id, name: before.name, size: before.size, duration: before.duration} : undefined,
        after: after ? {id: after.id, name: after.name, size: after.size, duration: after.duration} : undefined
      }));
      localStorage.setItem(storageKey(scope), JSON.stringify(stripped));
    } catch {
      setStatusMessage({text: 'تحذير: تعذر مزامنة البيانات في التخزين المحلي.', type: 'error'});
    }
  }, [scope]);

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
    setStatusMessage({text: 'تم تنظيف سجل التشغيل بالكامل.', type: 'info'});
  };

  // Play a single audio part with optional fade and gap
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
        reject(new Error('audio_decode_failed'));
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

      void audio.play().catch(err => {
        cleanup();
        reject(err);
      });
    });
  };

  // Run full sequence: Intro -> Gap -> Main (Repeats) -> Gap -> Outro
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

    try {
      // 1. Fetch Blobs from IndexedDB
      const mainBlob = await retrieveBlob(item.main.id);
      if (!mainBlob) throw new Error('الملف الأساسي غير موجود بالتخزين المحلي');
      const beforeBlob = item.beforeEnabled && item.before ? await retrieveBlob(item.before.id) : undefined;
      const afterBlob = item.afterEnabled && item.after ? await retrieveBlob(item.after.id) : undefined;

      // 2. Play Intro Music (if enabled)
      if (item.beforeEnabled && beforeBlob) {
        for (let r = 0; r < Math.max(1, item.beforeRepeats); r++) {
          if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
          setCurrentPlayback({
            activeId: item.id,
            phaseName: `موسيقى البداية (${r + 1} من ${item.beforeRepeats})`,
            repeatIndex: r + 1,
            totalRepeats: item.beforeRepeats,
            isPaused: false
          });
          await playPartWithFade(beforeBlob, item.beforeVolume, item.beforeFadeIn, item.beforeFadeOut, currentGen);
        }

        // Wait gap after intro music
        if (item.beforeGap > 0) {
          if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
          setCurrentPlayback({
            activeId: item.id,
            phaseName: `فاصل بعد موسيقى البداية (${item.beforeGap} ثانية)`,
            repeatIndex: 1,
            totalRepeats: 1,
            isPaused: false
          });
          await delay(item.beforeGap * 1000);
        }
      }

      // 3. Play Main Announcement (Repeated as configured)
      const mainReps = Math.max(1, item.mainRepeats);
      for (let r = 0; r < mainReps; r++) {
        if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
        setCurrentPlayback({
          activeId: item.id,
          phaseName: `النداء الأساسي (${r + 1} من ${mainReps})`,
          repeatIndex: r + 1,
          totalRepeats: mainReps,
          isPaused: false
        });
        await playPartWithFade(mainBlob, item.mainVolume, 0, 0, currentGen);

        // Gap between main repeats (not after the final repeat)
        if (r < mainReps - 1 && item.mainGap > 0) {
          if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
          setCurrentPlayback({
            activeId: item.id,
            phaseName: `فاصل بين تكرارات النداء (${item.mainGap} ثانية)`,
            repeatIndex: r + 1,
            totalRepeats: mainReps,
            isPaused: false
          });
          await delay(item.mainGap * 1000);
        }
      }

      // 4. Play Outro Music (if enabled, starts after all main repeats finish)
      if (item.afterEnabled && afterBlob) {
        // Gap before outro music
        if (item.afterGap > 0) {
          if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
          setCurrentPlayback({
            activeId: item.id,
            phaseName: `فاصل قبل موسيقى النهاية (${item.afterGap} ثانية)`,
            repeatIndex: 1,
            totalRepeats: 1,
            isPaused: false
          });
          await delay(item.afterGap * 1000);
        }

        for (let r = 0; r < Math.max(1, item.afterRepeats); r++) {
          if (playbackGeneration.current !== currentGen) throw new Error('cancelled');
          setCurrentPlayback({
            activeId: item.id,
            phaseName: `موسيقى النهاية (${r + 1} من ${item.afterRepeats})`,
            repeatIndex: r + 1,
            totalRepeats: item.afterRepeats,
            isPaused: false
          });
          await playPartWithFade(afterBlob, item.afterVolume, item.afterFadeIn, item.afterFadeOut, currentGen);
        }
      }

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
        if (isScheduled) {
          addLogEntry({
            id: logId,
            announcementId: item.id,
            name: item.name,
            date: nowStamp.toISOString().slice(0, 10),
            scheduledTime: nowStamp.toTimeString().slice(0, 5),
            status: 'فشل التشغيل',
            error: msg
          });
        }
        setStatusMessage({text: `خطأ في التشغيل: ${msg}`, type: 'error'});
      }
      setCurrentPlayback(null);
    }
  };

  // Preview runner (manual, lower priority than scheduled)
  const triggerPreview = (item: Announcement) => {
    void audioQueue.enqueue(() => executeSequence(item, false), true);
  };

  // Playback manual controls
  const handlePause = () => {
    if (activeAudioElement.current && !activeAudioElement.current.paused) {
      activeAudioElement.current.pause();
      setCurrentPlayback(prev => prev ? {...prev, isPaused: true} : null);
    }
  };

  const handleResume = () => {
    if (activeAudioElement.current && activeAudioElement.current.paused) {
      void activeAudioElement.current.play();
      setCurrentPlayback(prev => prev ? {...prev, isPaused: false} : null);
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
  };

  // Scheduled timer polling every second
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => {
      const now = new Date();
      const todayIndex = now.getDay();
      const todayDate = now.toISOString().slice(0, 10);
      const currentTime = now.toTimeString().slice(0, 5);

      const dueItems = items.filter(item => {
        if (!item.enabled || !item.main) return false;
        if (!item.times.includes(currentTime)) return false;

        const occurrenceKey = `${item.id}|${todayDate}|${currentTime}`;
        if (firedOccurrences.current.has(occurrenceKey)) return false;

        if (item.startDate && todayDate < item.startDate) return false;
        if (item.endDate && todayDate > item.endDate) return false;

        if (item.schedule === 'daily') return true;
        if (item.schedule === 'weekly') return item.days.includes(todayIndex);
        if (item.schedule === 'once') return (item.date ?? item.startDate) === todayDate;
        if (item.schedule === 'interval') {
          const startMs = Date.parse((item.startDate ?? todayDate) + 'T12:00:00Z');
          const currentMs = Date.parse(todayDate + 'T12:00:00Z');
          const diffDays = Math.round((currentMs - startMs) / 86400000);
          return diffDays >= 0 && diffDays % Math.max(1, item.interval) === 0;
        }
        return false;
      });

      dueItems.forEach(due => {
        const key = `${due.id}|${todayDate}|${currentTime}`;
        firedOccurrences.current.add(key);
        void audioQueue.enqueue(() => executeSequence(due, true), false);
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [items, visible]);

  // Form helpers
  const handleUpdateEditing = <K extends keyof Announcement>(field: K, val: Announcement[K]) => {
    setEditing(prev => prev ? {...prev, [field]: val} : null);
  };

  const handleFileUpload = async (field: 'main' | 'before' | 'after', file: File) => {
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
      handleUpdateEditing(field, part);
      if (field === 'before') handleUpdateEditing('beforeEnabled', true);
      if (field === 'after') handleUpdateEditing('afterEnabled', true);
      setStatusMessage({text: `تم رفع ملف (${file.name}) بنجاح.`, type: 'success'});
    } catch {
      setStatusMessage({text: 'فشل رفع وتخزين الملف الصوتي.', type: 'error'});
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      setStatusMessage({text: 'يرجى إدخال اسم النداء أولاً.', type: 'error'});
      return;
    }
    if (!editing.main || !editing.main.id) {
      setStatusMessage({text: 'يرجى رفع ملف النداء الأساسي الإلزامي.', type: 'error'});
      return;
    }
    if (!editing.times || editing.times.length === 0) {
      setStatusMessage({text: 'يرجى تحديد موعد تشغيل واحد على الأقل.', type: 'error'});
      return;
    }

    const exists = items.some(x => x.id === editing.id);
    const updated = exists ? items.map(x => x.id === editing.id ? editing : x) : [...items, editing];
    saveToStorage(updated);
    setEditing(null);
    setStatusMessage({text: 'تم حفظ إعدادات النداء وجدولته بنجاح.', type: 'success'});
  };

  const handleDelete = async (item: Announcement) => {
    if (!confirm(`هل أنت متأكد من حذف النداء "${item.name}" بالكامل؟`)) return;
    const remaining = items.filter(x => x.id !== item.id);
    saveToStorage(remaining);

    // Clean unreferenced blobs
    const usedIds = new Set<string>();
    remaining.forEach(r => {
      if (r.main?.id) usedIds.add(r.main.id);
      if (r.before?.id) usedIds.add(r.before.id);
      if (r.after?.id) usedIds.add(r.after.id);
    });

    const toDelete: string[] = [];
    if (item.main?.id && !usedIds.has(item.main.id)) toDelete.push(item.main.id);
    if (item.before?.id && !usedIds.has(item.before.id)) toDelete.push(item.before.id);
    if (item.after?.id && !usedIds.has(item.after.id)) toDelete.push(item.after.id);

    if (toDelete.length) await deleteBlobs(toDelete);
    setStatusMessage({text: 'تم حذف النداء وتنظيف الملفات غير المستخدمة.', type: 'info'});
  };

  const handleAddTime = () => {
    if (!editing) return;
    const clean = timeInput.trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(clean)) {
      setStatusMessage({text: 'يرجى إدخال وقت صحيح بصيغة 24 ساعة (مثال: 08:30)', type: 'error'});
      return;
    }
    if (!editing.times.includes(clean)) {
      handleUpdateEditing('times', [...editing.times, clean].sort());
      setTimeInput('');
    }
  };

  const handleRemoveTime = (t: string) => {
    if (!editing) return;
    handleUpdateEditing('times', editing.times.filter(x => x !== t));
  };

  // Timeline preview calculation for the editing item
  const timelineInfo = editing && editing.main ? calculateTimeline(editing) : null;

  return (
    <section className="announcements-page" hidden={!visible} dir="rtl">
      {/* Page Header */}
      <div className="section-head">
        <div>
          <span className="eyebrow">AUDIO SCHEDULER & PLAYER</span>
          <h1>إدارة النداءات الصوتية</h1>
          <p>نظام جدولة وتشغيل المقاطع الصوتية والموسيقى المرفوعة محلياً بدقة متناهية دون تداخل.</p>
        </div>
        <button className="button primary" onClick={() => setEditing(blankAnnouncement())}>
          <Plus data-icon="inline-start" /> إضافة نداء جديد
        </button>
      </div>

      {statusMessage && (
        <div className={`notification ${statusMessage.type === 'error' ? 'alert' : 'card'}`} role="status">
          <p>{statusMessage.text}</p>
        </div>
      )}

      {/* Floating Active Playback Controls Bar */}
      {currentPlayback && (
        <div className="card active-playback-bar" style={{border: '2px solid var(--accent, #eab308)', margin: '1rem 0'}}>
          <div className="card-head">
            <div>
              <span className="badge" style={{backgroundColor: '#eab308', color: '#000'}}>جاري التشغيل</span>
              <h3>{currentPlayback.phaseName}</h3>
            </div>
            <div className="actions" style={{display: 'flex', gap: '0.5rem'}}>
              {currentPlayback.isPaused ? (
                <button className="button primary" onClick={handleResume}>
                  <Play data-icon="inline-start" /> استكمال
                </button>
              ) : (
                <button className="button secondary" onClick={handlePause}>
                  <Pause data-icon="inline-start" /> إيقاف مؤقت
                </button>
              )}
              <button className="button secondary" onClick={handleStop} style={{color: '#ef4444'}}>
                <Square data-icon="inline-start" /> إيقاف نهائي
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Form Modal/Card */}
      {editing && (
        <section className="card announcement-form" style={{marginTop: '1.5rem', padding: '1.5rem'}}>
          <div className="card-head">
            <div>
              <h2>{items.some(x => x.id === editing.id) ? 'تعديل النداء' : 'إضافة نداء جديد'}</h2>
              <p>يتم تشغيل التسلسل: موسيقى البداية ➔ النداء الأساسي ➔ موسيقى النهاية.</p>
            </div>
            <button className="text-button" onClick={() => setEditing(null)}>إلغاء</button>
          </div>

          {/* Section 1: Name */}
          <div className="form-group" style={{margin: '1rem 0'}}>
            <label style={{display: 'block', fontWeight: 'bold', marginBottom: '0.5rem'}}>
              اسم النداء <span style={{color: '#ef4444'}}>*</span>
            </label>
            <input
              type="text"
              value={editing.name}
              onChange={e => handleUpdateEditing('name', e.target.value)}
              placeholder="مثال: بداية الطابور الصباحي، بداية الحصة الأولى..."
              style={{width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid #ccc'}}
              required
            />
          </div>

          <div className="dashboard-grid" style={{gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1rem', marginTop: '1rem'}}>
            {/* Section 2: Intro Music (Optional) */}
            <div className="card" style={{padding: '1rem', background: 'var(--card-bg, #1e293b)'}}>
              <div className="card-head">
                <h3><Music size={18} /> موسيقى قبل النداء</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={editing.beforeEnabled}
                    onChange={e => handleUpdateEditing('beforeEnabled', e.target.checked)}
                  /> تشغيل
                </label>
              </div>
              {editing.beforeEnabled ? (
                <div>
                  <label className="button secondary" style={{display: 'inline-block', margin: '0.5rem 0', cursor: 'pointer'}}>
                    <Upload size={16} /> {editing.before ? 'تغيير ملف الموسيقى' : 'رفع ملف موسيقى'}
                    <input
                      type="file"
                      accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac"
                      hidden
                      onChange={e => e.target.files?.[0] && void handleFileUpload('before', e.target.files[0])}
                    />
                  </label>
                  {editing.before && (
                    <div style={{fontSize: '0.875rem', margin: '0.5rem 0'}}>
                      <p><strong>الملف:</strong> {editing.before.name}</p>
                      <p><strong>المدة:</strong> {editing.before.duration ? `${Math.round(editing.before.duration)} ثانية` : 'غير محدد'}</p>
                      <button className="text-button" onClick={() => handleUpdateEditing('before', undefined)}>إزالة الموسيقى</button>
                    </div>
                  )}

                  <label style={{display: 'block', margin: '0.75rem 0'}}>
                    مستوى الصوت: {editing.beforeVolume}%
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={editing.beforeVolume}
                      onChange={e => handleUpdateEditing('beforeVolume', Number(e.target.value))}
                      style={{width: '100%'}}
                    />
                  </label>

                  <label style={{display: 'block', margin: '0.75rem 0'}}>
                    عدد مرات تشغيل موسيقى البداية:
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={editing.beforeRepeats}
                      onChange={e => handleUpdateEditing('beforeRepeats', Math.max(1, Number(e.target.value)))}
                      style={{width: '100%', padding: '0.5rem', marginTop: '0.25rem'}}
                    />
                  </label>

                  <label style={{display: 'block', margin: '0.75rem 0'}}>
                    الفاصل بعد موسيقى البداية:
                    <select
                      value={editing.beforeGap}
                      onChange={e => handleUpdateEditing('beforeGap', Number(e.target.value))}
                      style={{width: '100%', padding: '0.5rem', marginTop: '0.25rem'}}
                    >
                      <option value={0}>بدون فاصل</option>
                      <option value={3}>3 ثوانٍ</option>
                      <option value={5}>5 ثوانٍ</option>
                      <option value={10}>10 ثوانٍ</option>
                      <option value={15}>15 ثانية</option>
                    </select>
                  </label>

                  <div style={{display: 'flex', gap: '0.5rem', margin: '0.75rem 0'}}>
                    <label style={{flex: 1}}>
                      تدرج ظهور (Fade In):
                      <input
                        type="number"
                        min={0}
                        max={10}
                        value={editing.beforeFadeIn ?? 0}
                        onChange={e => handleUpdateEditing('beforeFadeIn', Number(e.target.value))}
                        style={{width: '100%', padding: '0.5rem'}}
                      />
                    </label>
                    <label style={{flex: 1}}>
                      تدرج اختفاء (Fade Out):
                      <input
                        type="number"
                        min={0}
                        max={10}
                        value={editing.beforeFadeOut ?? 0}
                        onChange={e => handleUpdateEditing('beforeFadeOut', Number(e.target.value))}
                        style={{width: '100%', padding: '0.5rem'}}
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <p className="form-note" style={{fontSize: '0.85rem', color: '#94a3b8'}}>موسيقى البداية غير مفعلة لهذا النداء.</p>
              )}
            </div>

            {/* Section 3: Main Announcement (Mandatory) */}
            <div className="card" style={{padding: '1rem', border: '1px solid var(--accent, #eab308)'}}>
              <div className="card-head">
                <h3><Volume2 size={18} /> ملف النداء الأساسي <span style={{color: '#ef4444'}}>*</span></h3>
              </div>
              <label className="button primary" style={{display: 'inline-block', margin: '0.5rem 0', cursor: 'pointer'}}>
                <Upload size={16} /> {editing.main ? 'استبدال ملف النداء' : 'رفع ملف النداء الأساسي'}
                <input
                  type="file"
                  accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac"
                  hidden
                  onChange={e => e.target.files?.[0] && void handleFileUpload('main', e.target.files[0])}
                />
              </label>

              {editing.main ? (
                <div style={{fontSize: '0.875rem', margin: '0.5rem 0', background: 'rgba(255,255,255,0.05)', padding: '0.5rem', borderRadius: '4px'}}>
                  <p><strong>اسم الملف:</strong> {editing.main.name}</p>
                  <p><strong>المدة:</strong> {editing.main.duration ? `${Math.round(editing.main.duration)} ثانية` : 'غير محدد'}</p>
                  <p><strong>الحجم:</strong> {(editing.main.size / (1024 * 1024)).toFixed(2)} MB</p>
                </div>
              ) : (
                <p style={{color: '#f87171', fontSize: '0.85rem'}}>يجب رفع ملف صوتي أساسي لحفظ النداء.</p>
              )}

              <label style={{display: 'block', margin: '0.75rem 0'}}>
                مستوى الصوت: {editing.mainVolume}%
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={editing.mainVolume}
                  onChange={e => handleUpdateEditing('mainVolume', Number(e.target.value))}
                  style={{width: '100%'}}
                />
              </label>

              <label style={{display: 'block', margin: '0.75rem 0'}}>
                عدد مرات تكرار النداء:
                <select
                  value={editing.mainRepeats}
                  onChange={e => handleUpdateEditing('mainRepeats', Number(e.target.value))}
                  style={{width: '100%', padding: '0.5rem', marginTop: '0.25rem'}}
                >
                  <option value={1}>مرة واحدة</option>
                  <option value={2}>مرتان</option>
                  <option value={3}>3 مرات</option>
                  <option value={4}>4 مرات</option>
                  <option value={5}>5 مرات</option>
                </select>
              </label>

              <label style={{display: 'block', margin: '0.75rem 0'}}>
                الفاصل بين تكرارات النداء:
                <select
                  value={editing.mainGap}
                  onChange={e => handleUpdateEditing('mainGap', Number(e.target.value))}
                  style={{width: '100%', padding: '0.5rem', marginTop: '0.25rem'}}
                >
                  <option value={0}>بدون فاصل</option>
                  <option value={3}>3 ثوانٍ</option>
                  <option value={5}>5 ثوانٍ</option>
                  <option value={10}>10 ثوانٍ</option>
                  <option value={15}>15 ثانية</option>
                  <option value={30}>30 ثانية</option>
                </select>
              </label>
            </div>

            {/* Section 4: Outro Music (Optional) */}
            <div className="card" style={{padding: '1rem', background: 'var(--card-bg, #1e293b)'}}>
              <div className="card-head">
                <h3><Music size={18} /> موسيقى بعد النداء</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={editing.afterEnabled}
                    onChange={e => handleUpdateEditing('afterEnabled', e.target.checked)}
                  /> تشغيل
                </label>
              </div>
              {editing.afterEnabled ? (
                <div>
                  <label className="button secondary" style={{display: 'inline-block', margin: '0.5rem 0', cursor: 'pointer'}}>
                    <Upload size={16} /> {editing.after ? 'تغيير ملف الموسيقى' : 'رفع ملف موسيقى'}
                    <input
                      type="file"
                      accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac"
                      hidden
                      onChange={e => e.target.files?.[0] && void handleFileUpload('after', e.target.files[0])}
                    />
                  </label>
                  {editing.after && (
                    <div style={{fontSize: '0.875rem', margin: '0.5rem 0'}}>
                      <p><strong>الملف:</strong> {editing.after.name}</p>
                      <p><strong>المدة:</strong> {editing.after.duration ? `${Math.round(editing.after.duration)} ثانية` : 'غير محدد'}</p>
                      <button className="text-button" onClick={() => handleUpdateEditing('after', undefined)}>إزالة الموسيقى</button>
                    </div>
                  )}

                  <label style={{display: 'block', margin: '0.75rem 0'}}>
                    مستوى الصوت: {editing.afterVolume}%
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={editing.afterVolume}
                      onChange={e => handleUpdateEditing('afterVolume', Number(e.target.value))}
                      style={{width: '100%'}}
                    />
                  </label>

                  <label style={{display: 'block', margin: '0.75rem 0'}}>
                    عدد مرات تشغيل موسيقى النهاية:
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={editing.afterRepeats}
                      onChange={e => handleUpdateEditing('afterRepeats', Math.max(1, Number(e.target.value)))}
                      style={{width: '100%', padding: '0.5rem', marginTop: '0.25rem'}}
                    />
                  </label>

                  <label style={{display: 'block', margin: '0.75rem 0'}}>
                    الفاصل قبل موسيقى النهاية:
                    <select
                      value={editing.afterGap}
                      onChange={e => handleUpdateEditing('afterGap', Number(e.target.value))}
                      style={{width: '100%', padding: '0.5rem', marginTop: '0.25rem'}}
                    >
                      <option value={0}>بدون فاصل</option>
                      <option value={2}>ثانيتان</option>
                      <option value={3}>3 ثوانٍ</option>
                      <option value={5}>5 ثوانٍ</option>
                      <option value={10}>10 ثوانٍ</option>
                    </select>
                  </label>

                  <div style={{display: 'flex', gap: '0.5rem', margin: '0.75rem 0'}}>
                    <label style={{flex: 1}}>
                      تدرج ظهور (Fade In):
                      <input
                        type="number"
                        min={0}
                        max={10}
                        value={editing.afterFadeIn ?? 0}
                        onChange={e => handleUpdateEditing('afterFadeIn', Number(e.target.value))}
                        style={{width: '100%', padding: '0.5rem'}}
                      />
                    </label>
                    <label style={{flex: 1}}>
                      تدرج اختفاء (Fade Out):
                      <input
                        type="number"
                        min={0}
                        max={10}
                        value={editing.afterFadeOut ?? 0}
                        onChange={e => handleUpdateEditing('afterFadeOut', Number(e.target.value))}
                        style={{width: '100%', padding: '0.5rem'}}
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <p className="form-note" style={{fontSize: '0.85rem', color: '#94a3b8'}}>موسيقى النهاية غير مفعلة لهذا النداء.</p>
              )}
            </div>
          </div>

          {/* Section 5: Scheduling Settings */}
          <div className="card" style={{marginTop: '1rem', padding: '1rem'}}>
            <h3><Calendar size={18} /> جدولة النداء وتحديد أوقات التشغيل</h3>
            <div className="form-row" style={{display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '1rem 0'}}>
              <label style={{flex: 1, minWidth: '200px'}}>
                نوع الجدولة:
                <select
                  value={editing.schedule}
                  onChange={e => handleUpdateEditing('schedule', e.target.value as Announcement['schedule'])}
                  style={{width: '100%', padding: '0.5rem', marginTop: '0.25rem'}}
                >
                  <option value="daily">يوميًا</option>
                  <option value="weekly">أيام محددة أسبوعيًا</option>
                  <option value="once">يوم واحد فقط</option>
                  <option value="interval">كل عدد معين من الأيام</option>
                </select>
              </label>

              <label style={{flex: 1, minWidth: '200px'}}>
                تاريخ البداية:
                <input
                  type="date"
                  value={editing.startDate}
                  onChange={e => handleUpdateEditing('startDate', e.target.value)}
                  style={{width: '100%', padding: '0.5rem', marginTop: '0.25rem'}}
                />
              </label>

              <label style={{flex: 1, minWidth: '200px'}}>
                تاريخ النهاية (اختياري):
                <input
                  type="date"
                  value={editing.endDate ?? ''}
                  onChange={e => handleUpdateEditing('endDate', e.target.value || undefined)}
                  style={{width: '100%', padding: '0.5rem', marginTop: '0.25rem'}}
                />
              </label>
            </div>

            {/* Weekly Days Selector */}
            {editing.schedule === 'weekly' && (
              <div style={{margin: '1rem 0'}}>
                <p style={{fontWeight: 'bold', marginBottom: '0.5rem'}}>الأيام المحددة أسبوعيًا:</p>
                <div style={{display: 'flex', gap: '0.5rem', flexWrap: 'wrap'}}>
                  {DAYS_NAMES.map((name, idx) => (
                    <button
                      type="button"
                      key={name}
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
                  ))}
                </div>
              </div>
            )}

            {/* Single Date Selector */}
            {editing.schedule === 'once' && (
              <div style={{margin: '1rem 0'}}>
                <label>
                  تاريخ التشغيل:
                  <input
                    type="date"
                    value={editing.date ?? editing.startDate}
                    onChange={e => handleUpdateEditing('date', e.target.value)}
                    style={{padding: '0.5rem', marginRight: '0.5rem'}}
                  />
                </label>
              </div>
            )}

            {/* Interval Days Selector */}
            {editing.schedule === 'interval' && (
              <div style={{margin: '1rem 0'}}>
                <label>
                  التشغيل كل عدد من الأيام:
                  <select
                    value={editing.interval}
                    onChange={e => handleUpdateEditing('interval', Number(e.target.value))}
                    style={{padding: '0.5rem', marginRight: '0.5rem'}}
                  >
                    <option value={2}>كل يومين</option>
                    <option value={3}>كل 3 أيام</option>
                    <option value={4}>كل 4 أيام</option>
                    <option value={5}>كل 5 أيام</option>
                    <option value={7}>كل 7 أيام</option>
                  </select>
                </label>
              </div>
            )}

            {/* Times Selector (Multiple Times Supported) */}
            <div style={{margin: '1rem 0'}}>
              <p style={{fontWeight: 'bold', marginBottom: '0.5rem'}}>أوقات التشغيل (ساعات ودقائق):</p>
              <div style={{display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem'}}>
                <input
                  type="time"
                  value={timeInput}
                  onChange={e => setTimeInput(e.target.value)}
                  style={{padding: '0.5rem'}}
                />
                <button type="button" className="button secondary" onClick={handleAddTime}>
                  + إضافة موعد
                </button>
              </div>
              <div style={{display: 'flex', gap: '0.5rem', flexWrap: 'wrap'}}>
                {editing.times.map(t => (
                  <span
                    key={t}
                    className="badge"
                    style={{padding: '0.4rem 0.8rem', background: '#334155', color: '#fff', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '0.5rem'}}
                  >
                    <Clock size={14} /> {t}
                    <button
                      type="button"
                      onClick={() => handleRemoveTime(t)}
                      style={{background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontWeight: 'bold'}}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* Timeline Calculation Notice */}
            {timelineInfo && (
              <div style={{padding: '0.75rem', background: 'rgba(234, 179, 8, 0.1)', borderRadius: '6px', borderLeft: '4px solid #eab308', marginTop: '1rem'}}>
                <p style={{margin: 0, fontSize: '0.9rem'}}>
                  <strong>ملاحظة التوقيت:</strong> يبدأ التسلسل الصوتي (موسيقى البداية إن وجدت) عند الوقت المحدد تماماً.
                  {timelineInfo.mainStartSeconds > 0 ? (
                    <span> يبدأ النداء الأساسي بعد <strong>{Math.round(timelineInfo.mainStartSeconds)} ثانية</strong> من بدء التسلسل.</span>
                  ) : (
                    <span> يبدأ النداء الأساسي مباشرةً عند حلول الموعد.</span>
                  )}
                  <span> إجمالي مدة التسلسل المقدرة: <strong>{Math.round(timelineInfo.totalSeconds)} ثانية</strong>.</span>
                </p>
              </div>
            )}
          </div>

          {/* Form Actions */}
          <div className="card-head" style={{marginTop: '1.5rem', display: 'flex', justifyContent: 'space-between'}}>
            <div style={{display: 'flex', gap: '0.75rem'}}>
              <button className="button primary" onClick={() => void handleSave()}>
                حفظ النداء
              </button>
              <button className="button secondary" onClick={() => triggerPreview(editing)}>
                <Play data-icon="inline-start" /> تجربة النداء كاملًا
              </button>
            </div>
            <button className="text-button" onClick={() => setEditing(null)}>
              إلغاء
            </button>
          </div>
        </section>
      )}

      {/* List of Announcements Cards */}
      <h2 style={{marginTop: '2rem', marginBottom: '1rem'}}>قائمة النداءات المجدولة ({items.length})</h2>
      <div className="dashboard-grid" style={{gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem'}}>
        {items.map(item => {
          const scheduleText = item.schedule === 'daily'
            ? 'يوميًا'
            : item.schedule === 'weekly'
              ? item.days.map(d => DAYS_NAMES[d]).join('، ')
              : item.schedule === 'once'
                ? `تاريخ محدد: ${item.date ?? item.startDate}`
                : `كل ${item.interval} أيام`;

          return (
            <article className="card announcement-card" key={item.id} style={{padding: '1rem', position: 'relative'}}>
              <div className="card-head" style={{marginBottom: '0.75rem'}}>
                <div>
                  <h3 style={{margin: 0}}>{item.name}</h3>
                  <span style={{fontSize: '0.85rem', color: '#94a3b8'}}>{item.main.name} · تكرار {item.mainRepeats} مرات</span>
                </div>
                <button
                  className={item.enabled ? 'badge' : 'badge secondary'}
                  style={{cursor: 'pointer', border: 'none', padding: '0.3rem 0.6rem'}}
                  onClick={() => {
                    const next = items.map(x => x.id === item.id ? {...x, enabled: !x.enabled} : x);
                    saveToStorage(next);
                  }}
                >
                  {item.enabled ? 'مفعل' : 'معطل'}
                </button>
              </div>

              <div style={{fontSize: '0.85rem', lineHeight: '1.6', margin: '0.75rem 0'}}>
                <p><strong>موسيقى البداية:</strong> {item.beforeEnabled && item.before ? `${item.before.name} (${item.beforeRepeats}x)` : 'غير مفعلة'}</p>
                <p><strong>موسيقى النهاية:</strong> {item.afterEnabled && item.after ? `${item.after.name} (${item.afterRepeats}x)` : 'غير مفعلة'}</p>
                <p><strong>الأيام:</strong> {scheduleText}</p>
                <p><strong>المواعيد:</strong> {item.times.join(' ، ')}</p>
              </div>

              <div className="card-head" style={{marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.75rem'}}>
                <button className="button secondary" onClick={() => triggerPreview(item)}>
                  <Play size={14} /> تشغيل تجريبي
                </button>
                <div style={{display: 'flex', gap: '0.5rem'}}>
                  <button className="text-button" onClick={() => setEditing(item)}>تعديل</button>
                  <button className="text-button" onClick={() => void handleDelete(item)} style={{color: '#f87171'}}>
                    <Trash2 size={16} /> حذف
                  </button>
                </div>
              </div>
            </article>
          );
        })}

        {!items.length && (
          <div className="card empty" style={{textAlign: 'center', padding: '2rem'}}>
            <Volume2 size={40} style={{margin: '0 auto 1rem', opacity: 0.5}} />
            <h3>لا توجد نداءات مضافة بعد</h3>
            <p>اضغط على زر <strong>+ إضافة نداء جديد</strong> لرفع ملف صوتي وتحديد أوقات تشغيله.</p>
          </div>
        )}
      </div>

      {/* Execution Logs Section */}
      <section className="card" style={{marginTop: '2.5rem', padding: '1.25rem'}}>
        <div className="card-head">
          <div>
            <h2>سجل تشغيل النداءات</h2>
            <p>سجل تفصيلي لعمليات التشغيل المجدولة والسابقة مع حالتها.</p>
          </div>
          {logs.length > 0 && (
            <button className="text-button" onClick={clearLogs}>تنظيف السجل</button>
          )}
        </div>

        {logs.length > 0 ? (
          <div style={{overflowX: 'auto', marginTop: '1rem'}}>
            <table style={{width: '100%', textAlign: 'right', borderCollapse: 'collapse', fontSize: '0.9rem'}}>
              <thead>
                <tr style={{borderBottom: '1px solid rgba(255,255,255,0.1)'}}>
                  <th style={{padding: '0.5rem'}}>اسم النداء</th>
                  <th style={{padding: '0.5rem'}}>التاريخ</th>
                  <th style={{padding: '0.5rem'}}>الموعد المجدول</th>
                  <th style={{padding: '0.5rem'}}>وقت البدء الفعلي</th>
                  <th style={{padding: '0.5rem'}}>الحالة</th>
                  <th style={{padding: '0.5rem'}}>ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 30).map(log => (
                  <tr key={log.id} style={{borderBottom: '1px solid rgba(255,255,255,0.05)'}}>
                    <td style={{padding: '0.5rem', fontWeight: 'bold'}}>{log.name}</td>
                    <td style={{padding: '0.5rem'}}>{log.date}</td>
                    <td style={{padding: '0.5rem'}}>{log.scheduledTime}</td>
                    <td style={{padding: '0.5rem'}}>{log.actualStartTime ? new Date(log.actualStartTime).toLocaleTimeString('ar-EG') : '-'}</td>
                    <td style={{padding: '0.5rem'}}>
                      <span className={`badge ${log.status === 'مكتمل' ? 'primary' : log.status === 'فشل التشغيل' ? 'alert' : 'secondary'}`}>
                        {log.status}
                      </span>
                    </td>
                    <td style={{padding: '0.5rem', color: log.error ? '#f87171' : 'inherit'}}>
                      {log.error ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="form-note" style={{marginTop: '1rem'}}>لا توجد سجلات تشغيل سابقة حتى الآن.</p>
        )}
      </section>
    </section>
  );
}

