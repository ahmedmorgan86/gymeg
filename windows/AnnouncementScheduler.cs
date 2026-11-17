using System.IO;
using System.Text.Json;

namespace GymOS.Windows;

public sealed class AnnouncementScheduler : IDisposable {
  private readonly string StorageDir;
  private readonly string AudioDir;
  private readonly string ScheduleFile;
  private readonly Action<bool> DuckMusic;
  private readonly Action<string> ReportStatus;
  private readonly Action<string> PostWebMessage;

  private Timer? TimerInstance;
  private CancellationTokenSource? ActiveCts;
  private readonly object SyncRoot = new();

  private readonly HashSet<string> FiredOccurrences = new();
  private readonly HashSet<string> ReportedScheduleErrors = new();
  private List<ScheduledItem> Items = new();
  private DateTimeOffset _previousTickUtc;

  public sealed class ScheduledItem {
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Branch { get; set; } = "";
    public string Timezone { get; set; } = "";
    public string Schedule { get; set; } = "daily"; // daily, weekly, once, interval
    public List<int> Days { get; set; } = new();
    public List<string> Times { get; set; } = new();
    public string? Date { get; set; }
    public string? StartDate { get; set; }
    public string? EndDate { get; set; }
    public int Interval { get; set; } = 1;
    public bool Enabled { get; set; } = true;
    public string? AudioFile { get; set; }
  }

  public AnnouncementScheduler(
    string rootDir,
    Action<bool> duckMusic,
    Action<string> reportStatus,
    Action<string> postWebMessage
  ) {
    DuckMusic = duckMusic;
    ReportStatus = reportStatus;
    PostWebMessage = postWebMessage;

    StorageDir = Path.Combine(rootDir, "Announcements");
    AudioDir = Path.Combine(StorageDir, "Audio");
    ScheduleFile = Path.Combine(StorageDir, "schedules.json");

    Directory.CreateDirectory(StorageDir);
    Directory.CreateDirectory(AudioDir);

    LoadPersistedSchedules();
    StartTimer();
  }

  private void StartTimer() {
    TimerInstance = new Timer(OnTick, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
  }

  private void LoadPersistedSchedules() {
    lock (SyncRoot) {
      if (File.Exists(ScheduleFile)) {
        try {
          var raw = File.ReadAllText(ScheduleFile);
          Items = JsonSerializer.Deserialize<List<ScheduledItem>>(raw) ?? new List<ScheduledItem>();
        } catch {
          Items = new List<ScheduledItem>();
        }
      }
    }
  }

  private void PersistSchedules() {
    lock (SyncRoot) {
      try {
        var json = JsonSerializer.Serialize(Items, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(ScheduleFile, json);
      } catch {
        // storage fallback
      }
    }
  }

  public void Sync(JsonElement message) {
    lock (SyncRoot) {
      try {
        if (!message.TryGetProperty("items", out var listElem) || listElem.ValueKind != JsonValueKind.Array) return;

        var nextItems = new List<ScheduledItem>();
        foreach (var itemElem in listElem.EnumerateArray()) {
          var item = new ScheduledItem {
            Id = itemElem.GetProperty("id").GetString() ?? Guid.NewGuid().ToString(),
            Name = itemElem.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
            Branch = itemElem.TryGetProperty("branch", out var b) ? b.GetString() ?? "" : "",
            Timezone = itemElem.TryGetProperty("timezone", out var tz) ? tz.GetString() ?? "" : "",
            Schedule = itemElem.TryGetProperty("schedule", out var s) ? s.GetString() ?? "daily" : "daily",
            Interval = itemElem.TryGetProperty("interval", out var inv) && inv.TryGetInt32(out var iVal) ? iVal : 1,
            Enabled = !itemElem.TryGetProperty("enabled", out var en) || en.GetBoolean()
          };

          if (itemElem.TryGetProperty("startDate", out var sd)) item.StartDate = sd.GetString();
          if (itemElem.TryGetProperty("endDate", out var ed)) item.EndDate = ed.GetString();
          if (itemElem.TryGetProperty("date", out var d)) item.Date = d.GetString();

          if (itemElem.TryGetProperty("times", out var timesElem) && timesElem.ValueKind == JsonValueKind.Array) {
            foreach (var t in timesElem.EnumerateArray()) {
              var str = t.GetString();
              if (!string.IsNullOrWhiteSpace(str)) item.Times.Add(str.Trim());
            }
          }

          if (itemElem.TryGetProperty("days", out var daysElem) && daysElem.ValueKind == JsonValueKind.Array) {
            foreach (var day in daysElem.EnumerateArray()) {
              if (day.TryGetInt32(out var dVal)) item.Days.Add(dVal);
            }
          }

          // If raw composed WAV base64 is passed, cache it on disk
          if (itemElem.TryGetProperty("wavBase64", out var wavElem) && wavElem.ValueKind == JsonValueKind.String) {
            var b64 = wavElem.GetString();
            if (!string.IsNullOrEmpty(b64)) {
              var filePath = Path.Combine(AudioDir, item.Id + ".wav");
              try {
                File.WriteAllBytes(filePath, Convert.FromBase64String(b64));
                item.AudioFile = filePath;
              } catch {
                // Ignore conversion errors
              }
            }
          } else {
            var existingPath = Path.Combine(AudioDir, item.Id + ".wav");
            if (File.Exists(existingPath)) item.AudioFile = existingPath;
          }

          nextItems.Add(item);
        }

        Items = nextItems;
        lock (SyncRoot) {
          var currentIds = nextItems.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
          ReportedScheduleErrors.RemoveWhere(id => !currentIds.Contains(id));
        }
        PersistSchedules();
        ReportStatus("تمت مزامنة النداءات المجدولة محليًا (" + Items.Count + ")");
      } catch (Exception ex) {
        ReportStatus("خطأ في مزامنة النداءات: " + ex.Message);
      }
    }
  }

  public void PlayNow(JsonElement message) {
    string id = message.TryGetProperty("id", out var idElem) ? idElem.GetString() ?? "" : "";
    string name = message.TryGetProperty("name", out var nameElem) ? nameElem.GetString() ?? "" : "";
    byte[]? wavBytes = null;

    if (message.TryGetProperty("wavBase64", out var wavElem) && wavElem.ValueKind == JsonValueKind.String) {
      try {
        var str = wavElem.GetString();
        if (!string.IsNullOrEmpty(str)) wavBytes = Convert.FromBase64String(str);
      } catch {}
    }

    if (wavBytes == null && !string.IsNullOrEmpty(id)) {
      var filePath = Path.Combine(AudioDir, id + ".wav");
      if (File.Exists(filePath)) {
        try { wavBytes = File.ReadAllBytes(filePath); } catch {}
      }
    }

    if (wavBytes != null) {
      _ = Task.Run(() => PlayAudioInternal(id, name, wavBytes, false));
    }
  }

  public void Stop() {
    lock (SyncRoot) {
      ActiveCts?.Cancel();
      ActiveCts = null;
    }
  }

  private void OnTick(object? state) {
    ScheduledItem[] currentList;
    lock (SyncRoot) {
      currentList = Items.ToArray();
    }

    if (currentList.Length == 0) return;

    DateTimeOffset nowUtc;
    IReadOnlyList<DateTimeOffset> samples;
    lock (SyncRoot) {
      nowUtc = DateTimeOffset.UtcNow;
      samples = AnnouncementScheduleClock.Samples(nowUtc, _previousTickUtc);
      _previousTickUtc = nowUtc;
    }

    foreach (var item in currentList) {
      if (!item.Enabled) continue;
      if (string.IsNullOrEmpty(item.AudioFile) || !File.Exists(item.AudioFile)) continue;
      if (string.IsNullOrWhiteSpace(item.Timezone)) {
        ReportScheduleErrorOnce(item.Id, "لم يُشغّل النداء «" + item.Name + "»: المنطقة الزمنية للنادي غير محددة. افتح إعدادات النادي ثم أعد حفظ الجدول.");
        continue;
      }

      foreach (var instant in samples) {
        AnnouncementScheduleClock.Sample local;
        try { local = AnnouncementScheduleClock.InClubTime(instant, item.Timezone); }
        catch (TimeZoneNotFoundException) {
          ReportScheduleErrorOnce(item.Id, "لم يُشغّل النداء «" + item.Name + "»: المنطقة الزمنية غير معروفة: " + item.Timezone);
          break;
        } catch (InvalidTimeZoneException) {
          ReportScheduleErrorOnce(item.Id, "لم يُشغّل النداء «" + item.Name + "»: إعداد المنطقة الزمنية غير صالح.");
          break;
        }

        if (!AnnouncementScheduleClock.IsDue(item.Schedule, item.Days, item.Times, item.Date, item.StartDate, item.EndDate, item.Interval, local)) continue;
        string occurrenceKey = $"{item.Id}|{local.Date:yyyy-MM-dd}|{local.Time:HH:mm}";
        lock (SyncRoot) {
          if (FiredOccurrences.Contains(occurrenceKey)) continue;
          FiredOccurrences.Add(occurrenceKey);
        }
        _ = Task.Run(() => {
          try {
            var bytes = File.ReadAllBytes(item.AudioFile);
            PlayAudioInternal(item.Id, item.Name, bytes, true);
          } catch (Exception ex) {
            ReportStatus("فشل تشغيل النداء المجدول: " + ex.Message);
          }
        });
      }
    }
  }

  private void ReportScheduleErrorOnce(string id, string message) {
    lock (SyncRoot) {
      if (!ReportedScheduleErrors.Add(id)) return;
    }
    ReportStatus(message);
  }

  private void PlayAudioInternal(string id, string name, byte[] wavBytes, bool isScheduled) {
    CancellationTokenSource cts;
    lock (SyncRoot) {
      ActiveCts?.Cancel();
      cts = new CancellationTokenSource();
      ActiveCts = cts;
    }

    try {
      // 1. Duck Music
      DuckMusic(true);

      // 2. Notify frontend that playback started
      PostWebMessage(JsonSerializer.Serialize(new {
        type = "gymos-desktop-announcement",
        status = "started",
        id,
        name,
        scheduled = isScheduled
      }));

      // 3. Play raw PCM WAV natively via winmm waveOut
      WavePlayback.Play(wavBytes, cts.Token);

      // 4. Notify frontend of successful completion
      PostWebMessage(JsonSerializer.Serialize(new {
        type = "gymos-desktop-announcement",
        status = "completed",
        id,
        name,
        scheduled = isScheduled
      }));
    } catch (OperationCanceledException) {
      PostWebMessage(JsonSerializer.Serialize(new {
        type = "gymos-desktop-announcement",
        status = "cancelled",
        id,
        name
      }));
    } catch (Exception ex) {
      PostWebMessage(JsonSerializer.Serialize(new {
        type = "gymos-desktop-announcement",
        status = "failed",
        id,
        name,
        error = ex.Message
      }));
    } finally {
      // 5. Restore music volume
      DuckMusic(false);
      lock (SyncRoot) {
        if (ReferenceEquals(ActiveCts, cts)) ActiveCts = null;
      }
    }
  }

  public void Dispose() {
    TimerInstance?.Dispose();
    Stop();
  }
}
