import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scheduledMinuteSamples,scheduledWallClockParts} from '../app/lib/announcement-schedule.ts';

test('a throttled timer recovers a recent missed minute once and ignores stale minutes',()=>{
 const minute=Date.parse('2026-11-03T04:05:00Z');
 const recent=scheduledMinuteSamples(minute-1000,new Date(minute+65_000));
 assert.equal(recent.length,2);
 assert.equal(recent[0].toISOString(),'2026-11-03T04:05:59.999Z');
 assert.equal(recent[1].toISOString(),'2026-11-03T04:06:05.000Z');
 assert.equal(scheduledMinuteSamples(minute-1000,new Date(minute+95_000)).length,1);
 assert.equal(scheduledMinuteSamples(minute+60_100,new Date(minute+65_000)).length,1);
 assert.equal(scheduledMinuteSamples(minute-3*60*60*1000,new Date(minute+65_000)).length,1);
});

test('browser schedules use the configured gym timezone and weekday rather than the device timezone',()=>{
 const mondayAtCairoMidnight=new Date('2026-11-01T22:30:00Z');
 assert.deepEqual(scheduledWallClockParts(mondayAtCairoMidnight,'Africa/Cairo'),{date:'2026-11-02',time:'00:30',weekday:1});
 assert.equal(scheduledWallClockParts(mondayAtCairoMidnight,'invalid/time-zone'),null);
});
