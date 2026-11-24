/** Recover a recently missed minute after a browser background timer resumes. */
export function scheduledMinuteSamples(previousTick: number, now: Date): Date[] {
  const minuteStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()).getTime();
  const samples = [now];
  const missedMinuteStart = minuteStart - 60_000;
  const elapsedSinceMissedMinute = now.getTime() - missedMinuteStart;
  const previousTickWasRecent = minuteStart - previousTick <= 90_000;
  if (
    previousTick < minuteStart &&
    previousTickWasRecent &&
    elapsedSinceMissedMinute >= 0 &&
    elapsedSinceMissedMinute <= 90_000
  ) {
    samples.unshift(new Date(minuteStart - 1));
  }
  return samples;
}

export type ScheduledWallClockParts = {
  date: string;
  time: string;
  weekday: number;
};

/** Read schedule fields in the gym's configured timezone, independent of device locale. */
export function scheduledWallClockParts(now: Date, timezone: string): ScheduledWallClockParts | null {
  if (!Number.isFinite(now.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23'
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'));
    const date = `${value('year')}-${value('month')}-${value('day')}`;
    const time = `${value('hour')}:${value('minute')}`;
    if (weekday < 0 || date.includes('undefined') || time.includes('undefined')) return null;
    return { date, time, weekday };
  } catch {
    return null;
  }
}
