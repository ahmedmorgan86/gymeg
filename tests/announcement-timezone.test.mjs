import {test} from 'node:test';
import assert from 'node:assert/strict';
import {announcementOccurrence} from '../app/lib/announcements.ts';

const weeklyAnnouncement=(overrides={})=>({
  id:'timezone-weekly',
  branch:'main',
  enabled:true,
  schedule:'weekly',
  days:[1],
  times:['00:30'],
  startDate:'2026-11-02',
  interval:1,
  timezone:'Africa/Cairo',
  ...overrides
});

test('weekly announcements select the weekday in the configured club timezone',()=>{
  // 22:30 UTC on Sunday is 00:30 Monday in Cairo.
  const now=Date.parse('2026-11-01T22:30:00Z');
  assert.equal(announcementOccurrence(weeklyAnnouncement(),now),'2026-11-02T00:30');
  assert.equal(announcementOccurrence(weeklyAnnouncement({days:[0]}),now),null);
});

test('invalid time zones fail closed instead of breaking announcement polling',()=>{
  assert.equal(announcementOccurrence(weeklyAnnouncement({timezone:'invalid/time-zone'}),Date.parse('2026-11-01T22:30:00Z')),null);
});
