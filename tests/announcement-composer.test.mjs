import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateComposedDuration,
  computeCompositionFingerprint,
  encodePcmWav,
  MAX_ANNOUNCEMENT_DURATION_SECONDS,
  SAFE_MAX_DURATION_SECONDS
} from '../app/lib/announcement-composer.ts';
import {
  validateAnnouncementSequence,
  calculateTimeline,
  audioQueue
} from '../app/lib/announcement-audio.ts';

test('3-Part Sequence Duration calculation conforms to Alert Chime -> Gap -> Main -> Gap -> Alert Chime', () => {
  const result = calculateComposedDuration({
    mainDuration: 12.0,
    chimeDuration: 3.5,
    chimeGap: 0.5
  });

  // Start Chime (3.5s) + Gap (0.5s) + Main (12.0s) + Gap (0.5s) + End Chime (3.5s)
  // Total = 3.5 + 0.5 + 12.0 + 0.5 + 3.5 = 20.0s
  assert.equal(result.startChimeDuration, 3.5);
  assert.equal(result.endChimeDuration, 3.5);
  assert.equal(result.mainDuration, 12.0);
  assert.equal(result.gapSeconds, 0.5);
  assert.equal(result.totalSeconds, 20.0);
  assert.equal(result.exceedsLimit, false);
});

test('Duration boundary validation enforces strict < 30.0s limit', () => {
  // Exactly 29.5s (within SAFE_MAX_DURATION_SECONDS)
  const valid = calculateComposedDuration({
    mainDuration: 21.5,
    chimeDuration: 3.5,
    chimeGap: 0.5
  });
  // 3.5 + 0.5 + 21.5 + 0.5 + 3.5 = 29.5s
  assert.equal(valid.totalSeconds, 29.5);
  assert.equal(valid.exceedsLimit, false);

  // Exactly 30.0s -> Exceeds limit
  const boundary = calculateComposedDuration({
    mainDuration: 22.0,
    chimeDuration: 3.5,
    chimeGap: 0.5
  });
  // 3.5 + 0.5 + 22.0 + 0.5 + 3.5 = 30.0s
  assert.equal(boundary.totalSeconds, 30.0);
  assert.equal(boundary.exceedsLimit, true);

  // 32.0s -> Exceeds limit
  const invalid = calculateComposedDuration({
    mainDuration: 24.0,
    chimeDuration: 3.5,
    chimeGap: 0.5
  });
  assert.equal(invalid.totalSeconds, 32.0);
  assert.equal(invalid.exceedsLimit, true);
});

test('computeCompositionFingerprint generates deterministic and distinctive cache keys', () => {
  const fp1 = computeCompositionFingerprint({
    announcementId: 'ann-123',
    mainId: 'main-blob-1',
    mainSize: 10240,
    mainDuration: 15.2,
    mainVolume: 100,
    chimeId: 'chime-default',
    chimeSize: 62000,
    chimeVolume: 80,
    chimeGap: 0.5
  });

  const fp2 = computeCompositionFingerprint({
    announcementId: 'ann-123',
    mainId: 'main-blob-1',
    mainSize: 10240,
    mainDuration: 15.2,
    mainVolume: 100,
    chimeId: 'chime-default',
    chimeSize: 62000,
    chimeVolume: 80,
    chimeGap: 0.5
  });

  const fpDifferentDuration = computeCompositionFingerprint({
    announcementId: 'ann-123',
    mainId: 'main-blob-1',
    mainSize: 10240,
    mainDuration: 18.0,
    mainVolume: 100,
    chimeId: 'chime-default',
    chimeSize: 62000,
    chimeVolume: 80,
    chimeGap: 0.5
  });

  assert.equal(fp1, fp2, 'Fingerprint must be deterministic for identical inputs');
  assert.notEqual(fp1, fpDifferentDuration, 'Fingerprint must differ when duration changes');
  assert.ok(fp1.startsWith('comp_v1_'), 'Fingerprint must follow versioned prefix');
});

test('encodePcmWav creates a valid RIFF PCM WAV binary header and byte structure', () => {
  const sampleRate = 44100;
  const numChannels = 1;
  const length = 4410; // 0.1s
  const channelData = new Float32Array(length);

  // Generate a test 440Hz sine wave
  for (let i = 0; i < length; i++) {
    channelData[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }

  const wavBuffer = encodePcmWav([channelData], sampleRate);
  assert.ok(wavBuffer instanceof ArrayBuffer);

  const view = new DataView(wavBuffer);
  // RIFF header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  assert.equal(riff, 'RIFF');

  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  assert.equal(wave, 'WAVE');

  // fmt chunk
  const fmt = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
  assert.equal(fmt, 'fmt ');
  assert.equal(view.getUint16(20, true), 1); // PCM format = 1
  assert.equal(view.getUint16(22, true), numChannels);
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint16(34, true), 16); // 16-bit

  // data chunk
  const dataTag = String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39));
  assert.equal(dataTag, 'data');
  assert.equal(view.getUint32(40, true), length * numChannels * 2);

  // Total buffer length: 44 bytes header + sample data
  assert.equal(wavBuffer.byteLength, 44 + length * numChannels * 2);
});

test('validateAnnouncementSequence rejects items >= 30 seconds with informative Arabic error', () => {
  const validItem = {
    id: 'ann-ok',
    name: 'Short alert',
    main: { id: 'm1', name: 'main.wav', size: 1000, duration: 15.0 },
    mainVolume: 100,
    mainRepeats: 1,
    mainGap: 0,
    before: { id: 'b1', name: 'chime.wav', size: 500, duration: 3.5 },
    beforeEnabled: true,
    beforeVolume: 80,
    beforeRepeats: 1,
    beforeGap: 1,
    after: { id: 'b1', name: 'chime.wav', size: 500, duration: 3.5 },
    afterEnabled: true,
    afterVolume: 80,
    afterRepeats: 1,
    afterGap: 1
  };
  // 3.5 + 1 + 15 + 1 + 3.5 = 24.0s
  const validRes = validateAnnouncementSequence(validItem);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.exceedsLimit, false);
  assert.equal(validRes.totalSeconds, 24.0);
  assert.equal(validRes.error, undefined);

  const invalidItem = {
    ...validItem,
    main: { id: 'm2', name: 'long-announcement.wav', size: 5000, duration: 25.0 }
  };
  // 3.5 + 1 + 25 + 1 + 3.5 = 34.0s
  const invalidRes = validateAnnouncementSequence(invalidItem);
  assert.equal(invalidRes.valid, false);
  assert.equal(invalidRes.exceedsLimit, true);
  assert.equal(invalidRes.totalSeconds, 34.0);
  assert.ok(invalidRes.error?.includes('تتجاوز الحد الأقصى 30 ثانية'));
});
