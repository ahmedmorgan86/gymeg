/** Recover a recently missed minute after a browser background timer resumes. */
export function scheduledMinuteSamples(previousTick: number, now: Date): Date[] {
  const minuteStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()).getTime();
  const samples = [now];
  if (previousTick < minuteStart && now.getTime() - (minuteStart - 60_000) <= 90_000) {
    samples.unshift(new Date(minuteStart - 1));
  }
  return samples;
}
