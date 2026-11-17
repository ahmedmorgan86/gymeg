using System.Globalization;

namespace GymOS.Windows;

/// <summary>Deterministic schedule calculations using the club timezone, never the PC timezone.</summary>
public static class AnnouncementScheduleClock {
  public sealed record Sample(DateOnly Date, TimeOnly Time, DayOfWeek Weekday, DateTimeOffset InstantUtc);

  public static IReadOnlyList<DateTimeOffset> Samples(DateTimeOffset nowUtc, DateTimeOffset previousTickUtc) {
    nowUtc = nowUtc.ToUniversalTime();
    previousTickUtc = previousTickUtc.ToUniversalTime();
    var result = new List<DateTimeOffset>(2);
    var minuteStart = new DateTimeOffset(nowUtc.Year, nowUtc.Month, nowUtc.Day, nowUtc.Hour, nowUtc.Minute, 0, TimeSpan.Zero);
    var elapsedAfterMinuteStart = nowUtc - minuteStart;
    if (previousTickUtc < minuteStart && minuteStart - previousTickUtc <= TimeSpan.FromSeconds(90) &&
        elapsedAfterMinuteStart <= TimeSpan.FromSeconds(90)) {
      result.Add(minuteStart.AddMinutes(-1));
    }
    result.Add(nowUtc);
    return result;
  }

  public static Sample InClubTime(DateTimeOffset instantUtc, string? timezone) {
    if (string.IsNullOrWhiteSpace(timezone)) throw new ArgumentException("Club timezone is required.", nameof(timezone));
    var zone = TimeZoneInfo.FindSystemTimeZoneById(timezone);
    var local = TimeZoneInfo.ConvertTime(instantUtc.ToUniversalTime(), zone);
    var date = DateOnly.FromDateTime(local.DateTime);
    return new Sample(date, new TimeOnly(local.Hour, local.Minute), date.DayOfWeek, instantUtc.ToUniversalTime());
  }

  public static bool IsDue(
    string schedule,
    IReadOnlyCollection<int> days,
    IEnumerable<string> times,
    string? date,
    string? startDate,
    string? endDate,
    int interval,
    Sample sample
  ) {
    if (!times.Any(time => TryTime(time, out var parsed) && parsed == sample.Time)) return false;
    if (!TryDate(startDate, out var start)) start = sample.Date;
    if (!TryDate(endDate, out var end) && !string.IsNullOrWhiteSpace(endDate)) return false;
    if (sample.Date < start || (TryDate(endDate, out end) && sample.Date > end)) return false;

    return schedule switch {
      "daily" => true,
      "weekly" => days.Contains((int)sample.Weekday),
      "once" => TryDate(date ?? startDate, out var once) && sample.Date == once,
      "interval" => (sample.Date.DayNumber - start.DayNumber) >= 0 &&
                    (sample.Date.DayNumber - start.DayNumber) % Math.Max(1, interval) == 0,
      _ => false
    };
  }

  private static bool TryTime(string? value, out TimeOnly time) =>
    TimeOnly.TryParseExact(value?.Trim(), ["H:mm", "HH:mm"], CultureInfo.InvariantCulture, DateTimeStyles.None, out time);

  private static bool TryDate(string? value, out DateOnly date) =>
    DateOnly.TryParseExact(value?.Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date);
}
