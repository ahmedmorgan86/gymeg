using GymOS.Windows;

static void Check(bool value, string message) {
  if (!value) throw new Exception(message);
}

var cairo = AnnouncementScheduleClock.InClubTime(DateTimeOffset.Parse("2026-11-07T18:30:35Z"), "Africa/Cairo");
Check(cairo.Date == new DateOnly(2026, 11, 7) && cairo.Time == new TimeOnly(20, 30) && cairo.Weekday == DayOfWeek.Saturday,
  "Club timezone conversion must ignore the PC timezone and discard seconds.");
Check(AnnouncementScheduleClock.IsDue("weekly", [6], ["20:30"], null, null, null, 1, cairo),
  "Weekly schedule must match the club-local weekday and time.");
Check(!AnnouncementScheduleClock.IsDue("weekly", [0], ["20:30"], null, null, null, 1, cairo),
  "Weekly schedule must not match a different club-local weekday.");
Check(!AnnouncementScheduleClock.IsDue("daily", [], ["20:31"], null, null, null, 1, cairo),
  "A schedule must not fire in the wrong minute.");
Check(AnnouncementScheduleClock.IsDue("interval", [], ["20:30"], null, "2026-11-03", null, 2, cairo),
  "Interval schedules must be computed from ISO club-local dates.");
Check(!AnnouncementScheduleClock.IsDue("interval", [], ["20:30"], null, "2026-11-04", null, 2, cairo),
  "Interval schedules must not drift by the PC culture or timezone.");

var now = DateTimeOffset.Parse("2026-11-07T18:31:04Z");
var recovered = AnnouncementScheduleClock.Samples(now, DateTimeOffset.Parse("2026-11-07T18:30:59Z"));
Check(recovered.Count == 2 && recovered[0] == DateTimeOffset.Parse("2026-11-07T18:30:00Z"),
  "A delayed Windows timer must recover only the immediately previous minute.");
var stale = AnnouncementScheduleClock.Samples(now, DateTimeOffset.Parse("2026-11-07T18:25:00Z"));
Check(stale.Count == 1, "A stale timer delay must not trigger an old announcement.");

Console.WriteLine("PASS: Cairo timezone, weekday, exact minute, interval dates, recent-tick recovery, and stale-tick rejection.");
