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
