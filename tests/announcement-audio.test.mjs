import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTimeline, audioQueue } from '../app/lib/announcement-audio.ts';
import { announcementOccurrence, dueAnnouncement } from '../app/lib/announcements.ts';

test('calculateTimeline accurately accounts for intro music, repeats, gaps, main repeats, and outro music', () => {
  const item = {
    id: 'ann-1',
    name: 'Closing Gym',
    main: { id: 'm1', name: 'main.mp3', size: 1024, duration: 10 },
    mainVolume: 90,
    mainRepeats: 2,
    mainGap: 3, // gap between main repeats = 3s
    before: { id: 'b1', name: 'intro.mp3', size: 500, duration: 5 },
    beforeEnabled: true,
    beforeVolume: 80,
    beforeRepeats: 1,
    beforeGap: 2, // gap after intro = 2s
    after: { id: 'a1', name: 'outro.mp3', size: 600, duration: 7 },
    afterEnabled: true,
    afterVolume: 70,
    afterRepeats: 1,
    afterGap: 4 // gap before outro = 4s
  };

  const timeline = calculateTimeline(item);
  // Intro: 5 * 1 = 5s + 2s gap = 7s before main starts
  assert.equal(timeline.mainStartSeconds, 7);

  // Main: 10s * 2 + 3s gap = 23s
  // Outro: 4s gap + 7s * 1 = 11s
  // Total: 7s (intro+gap) + 23s (main) + 11s (outro+gap) = 41s
  assert.equal(timeline.totalSeconds, 41);
});

test('calculateTimeline handles sequences with only main announcement (no intro, no outro)', () => {
  const item = {
    id: 'ann-2',
    name: 'Simple alert',
    main: { id: 'm2', name: 'alert.mp3', size: 100, duration: 8 },
    mainVolume: 100,
    mainRepeats: 3,
    mainGap: 2,
    beforeEnabled: false,
    beforeVolume: 80,
    beforeRepeats: 1,
    beforeGap: 0,
    afterEnabled: false,
    afterVolume: 80,
    afterRepeats: 1,
    afterGap: 0
  };

  const timeline = calculateTimeline(item);
  assert.equal(timeline.mainStartSeconds, 0);
  // Main: 8 * 3 + (3 - 1) * 2 = 24 + 4 = 28s
  assert.equal(timeline.totalSeconds, 28);
});

test('audioQueue coordinates tasks and cancels manual preview when scheduled announcement arrives', async () => {
  const events = [];
  let manualCancelled = false;

  const p1 = audioQueue.enqueue(async (signal) => {
    events.push('preview:start');
    for (let i = 0; i < 10; i++) {
      if (signal.cancelled) {
        manualCancelled = true;
        events.push('preview:cancelled');
        return;
      }
      await new Promise(r => setTimeout(r, 10));
    }
    events.push('preview:done');
  }, true);

  // Scheduled announcement arrives while preview is running
  await new Promise(r => setTimeout(r, 15));
  const p2 = audioQueue.enqueue(async () => {
    events.push('scheduled:start');
    events.push('scheduled:done');
  }, false);

  await Promise.all([p1, p2]);

  assert.equal(manualCancelled, true);
  assert.ok(events.includes('preview:cancelled'));
  assert.ok(events.includes('scheduled:start'));
  assert.ok(events.includes('scheduled:done'));
});

test('announcementOccurrence correctly checks multiple daily times and weekly days', () => {
  const a = {
    id: 'ann-weekly',
    branch: 'main',
    name: 'Weekly Prayer',
    enabled: true,
    schedule: 'weekly',
    days: [5], // Friday = 5
    times: ['12:30', '18:00'],
    timezone: 'UTC'
  };

  // 2026-11-06 is a Friday
  const friday1230 = Date.parse('2026-11-06T12:30:00Z');
  const friday1800 = Date.parse('2026-11-06T18:00:00Z');
  const friday1300 = Date.parse('2026-11-06T13:00:00Z');
  // 2026-11-07 is Saturday
  const saturday1230 = Date.parse('2026-11-07T12:30:00Z');

  assert.equal(announcementOccurrence(a, friday1230), '2026-11-06T12:30');
  assert.equal(announcementOccurrence(a, friday1800), '2026-11-06T18:00');
  assert.equal(announcementOccurrence(a, friday1300), null);
  assert.equal(announcementOccurrence(a, saturday1230), null);

  assert.equal(dueAnnouncement(a, friday1230, null), true);
  assert.equal(dueAnnouncement(a, friday1230, '2026-11-06T12:30'), false);
});
