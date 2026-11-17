import { DEFAULT_CHIME_PART, type AudioPart } from './announcement-audio.ts';

export const MAX_ANNOUNCEMENT_DURATION_SECONDS = 30.0;
export const SAFE_MAX_DURATION_SECONDS = 29.5;

export interface AnnouncementCompositionInput {
  id: string;
  name: string;
  main: AudioPart;
  mainVolume?: number; // 0 - 100
  chime?: AudioPart;
  chimeVolume?: number; // 0 - 100
  chimeGap?: number; // gap between chime and main in seconds (default: 0.5s)
}

export interface ComposedAudioResult {
  id: string;
  fingerprint: string;
  durationSeconds: number;
  exceedsLimit: boolean;
  wavBlob?: Blob;
  base64?: string;
  error?: string;
}

/**
 * Calculates the total expected duration of the 3-part sequence:
 * [Start Chime] -> [Gap] -> [Main Announcement] -> [Gap] -> [End Chime]
 */
export function calculateComposedDuration(input: {
  mainDuration: number;
  chimeDuration?: number;
  chimeGap?: number;
}): {
  startChimeDuration: number;
  mainDuration: number;
  endChimeDuration: number;
  gapSeconds: number;
  totalSeconds: number;
  exceedsLimit: boolean;
} {
  const chimeDur = Math.max(0, input.chimeDuration ?? DEFAULT_CHIME_PART.duration ?? 3.5);
  const mainDur = Math.max(0, input.mainDuration);
  const gap = Math.max(0, input.chimeGap ?? 0.5);

  const startChimeDuration = chimeDur;
  const endChimeDuration = chimeDur; // Exactly identical to start chime
  const totalSeconds = Number((startChimeDuration + gap + mainDur + gap + endChimeDuration).toFixed(2));
  const exceedsLimit = totalSeconds >= MAX_ANNOUNCEMENT_DURATION_SECONDS;

  return {
    startChimeDuration,
    mainDuration: mainDur,
    endChimeDuration,
    gapSeconds: gap,
    totalSeconds,
    exceedsLimit
  };
}

/**
 * Computes a deterministic fingerprint for caching composed announcements.
 */
export function computeCompositionFingerprint(input: {
  announcementId: string;
  mainId: string;
  mainSize: number;
  mainDuration: number;
  mainVolume?: number;
  chimeId?: string;
  chimeSize?: number;
  chimeVolume?: number;
  chimeGap?: number;
}): string {
  const key = [
    input.announcementId,
    input.mainId,
    input.mainSize,
    Math.round((input.mainDuration || 0) * 100),
    input.mainVolume ?? 100,
    input.chimeId ?? DEFAULT_CHIME_PART.id,
    input.chimeSize ?? DEFAULT_CHIME_PART.size,
    input.chimeVolume ?? 80,
    input.chimeGap ?? 0.5
  ].join(':');

  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return `comp_v1_${Math.abs(hash).toString(16)}`;
}

/**
 * Helper to encode an AudioBuffer (or Float32Array channel data) into a compliant 16-bit PCM WAV ArrayBuffer.
 */
export function encodePcmWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numChannels = channels.length;
  const length = channels[0].length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF identifier
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + dataSize, true); // file size - 8
  view.setUint32(8, 0x57415645, false); // "WAVE"

  // "fmt " sub-chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bitsPerSample

  // "data" sub-chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);

  // Interleave and scale float samples to int16
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channels[ch][i];
      // Clamp between -1 and 1
      sample = Math.max(-1, Math.min(1, sample));
      // Scale to 16-bit signed integer
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return buffer;
}

/**
 * Composes the 3-part sequence into a single unified WAV audio file.
 * Order: Alert Chime -> Gap -> Main Announcement -> Gap -> Alert Chime
 * Validates total duration < 30 seconds.
 */
export async function composeAnnouncementAudio(
  input: AnnouncementCompositionInput,
  chimeBlob: Blob,
  mainBlob: Blob
): Promise<ComposedAudioResult> {
  const chimeDur = input.chime?.duration ?? DEFAULT_CHIME_PART.duration ?? 3.5;
  const mainDur = input.main.duration ?? 0;
  const gap = input.chimeGap ?? 0.5;

  const timeline = calculateComposedDuration({
    mainDuration: mainDur,
    chimeDuration: chimeDur,
    chimeGap: gap
  });

  const fingerprint = computeCompositionFingerprint({
    announcementId: input.id,
    mainId: input.main.id,
    mainSize: input.main.size,
    mainDuration: mainDur,
    mainVolume: input.mainVolume,
    chimeId: input.chime?.id,
    chimeSize: input.chime?.size,
    chimeVolume: input.chimeVolume,
    chimeGap: gap
  });

  if (timeline.exceedsLimit) {
    return {
      id: input.id,
      fingerprint,
      durationSeconds: timeline.totalSeconds,
      exceedsLimit: true,
      error: `إجمالي مدة النداء (${timeline.totalSeconds} ثانية) تتجاوز الحد الأقصى المسموح به وهو 30 ثانية.`
    };
  }

  // If in browser with Web Audio API, render seamless buffer
  if (typeof window !== 'undefined' && (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)) {
    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const tempCtx = new AudioContextClass();

      const [chimeBuffer, mainBuffer] = await Promise.all([
        tempCtx.decodeAudioData(await chimeBlob.arrayBuffer()),
        tempCtx.decodeAudioData(await mainBlob.arrayBuffer())
      ]);

      const sampleRate = 44100;
      const numChannels = Math.max(chimeBuffer.numberOfChannels, mainBuffer.numberOfChannels, 1);
      const gapSamples = Math.round(gap * sampleRate);
      const chimeSamples = Math.round((chimeBuffer.length / chimeBuffer.sampleRate) * sampleRate);
      const mainSamples = Math.round((mainBuffer.length / mainBuffer.sampleRate) * sampleRate);

      // Total samples = Chime1 + Gap + Main + Gap + Chime2
      const totalSamples = chimeSamples + gapSamples + mainSamples + gapSamples + chimeSamples;
      const calculatedDuration = totalSamples / sampleRate;

      if (calculatedDuration >= MAX_ANNOUNCEMENT_DURATION_SECONDS) {
        tempCtx.close().catch(() => {});
        return {
          id: input.id,
          fingerprint,
          durationSeconds: Number(calculatedDuration.toFixed(2)),
          exceedsLimit: true,
          error: `المدة الفعلية المدمجة (${calculatedDuration.toFixed(1)} ثانية) تتجاوز 30 ثانية.`
        };
      }

      // Offline render
      const offlineCtx = new OfflineAudioContext(numChannels, totalSamples, sampleRate);

      const chimeVol = Math.max(0, Math.min(1, (input.chimeVolume ?? 80) / 100));
      const mainVol = Math.max(0, Math.min(1, (input.mainVolume ?? 100) / 100));

      // 1. Start Chime
      const source1 = offlineCtx.createBufferSource();
      source1.buffer = chimeBuffer;
      const gain1 = offlineCtx.createGain();
      gain1.gain.value = chimeVol;
      source1.connect(gain1);
      gain1.connect(offlineCtx.destination);
      source1.start(0);

      // 2. Main Announcement
      const mainStartTime = (chimeSamples + gapSamples) / sampleRate;
      const source2 = offlineCtx.createBufferSource();
      source2.buffer = mainBuffer;
      const gain2 = offlineCtx.createGain();
      gain2.gain.value = mainVol;
      source2.connect(gain2);
      gain2.connect(offlineCtx.destination);
      source2.start(mainStartTime);

      // 3. End Chime (Identical to Start Chime)
      const endStartTime = mainStartTime + (mainSamples + gapSamples) / sampleRate;
      const source3 = offlineCtx.createBufferSource();
      source3.buffer = chimeBuffer;
      const gain3 = offlineCtx.createGain();
      gain3.gain.value = chimeVol;
      source3.connect(gain3);
      gain3.connect(offlineCtx.destination);
      source3.start(endStartTime);

      const renderedBuffer = await offlineCtx.startRendering();
      tempCtx.close().catch(() => {});

      const channelsData: Float32Array[] = [];
      for (let ch = 0; ch < renderedBuffer.numberOfChannels; ch++) {
        channelsData.push(renderedBuffer.getChannelData(ch));
      }

      const wavBuffer = encodePcmWav(channelsData, sampleRate);
      const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });

      return {
        id: input.id,
        fingerprint,
        durationSeconds: Number(calculatedDuration.toFixed(2)),
        exceedsLimit: false,
        wavBlob
      };
    } catch (e) {
      console.warn('Web Audio composition failed, using sequence metadata:', e);
    }
  }

  // Fallback for Node.js / non-audio environments
  return {
    id: input.id,
    fingerprint,
    durationSeconds: timeline.totalSeconds,
    exceedsLimit: timeline.exceedsLimit
  };
}
