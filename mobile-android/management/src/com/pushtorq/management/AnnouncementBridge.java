package com.pushtorq.management;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.Set;

public final class AnnouncementBridge {
    private final Context context;
    private static final String PREF_NAME = "gymeg_announcements";
    private static final String KEY_SCHEDULES = "schedules_json";

    public AnnouncementBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    @JavascriptInterface
    public void syncAnnouncements(String jsonString) {
        if (jsonString == null) return;
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            String previousJson = prefs.getString(KEY_SCHEDULES, null);
            prefs.edit().putString(KEY_SCHEDULES, jsonString).apply();

            JSONArray array = new JSONArray(jsonString);
            Set<String> currentIds = new HashSet<>();
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item != null) currentIds.add(item.optString("id"));
            }
            if (previousJson != null) {
                JSONArray previous = new JSONArray(previousJson);
                for (int i = 0; i < previous.length(); i++) {
                    JSONObject item = previous.optJSONObject(i);
                    String oldId = item != null ? item.optString("id") : "";
                    if (!oldId.isEmpty() && !currentIds.contains(oldId)) cancelAlarm(oldId);
                }
            }
            File audioDir = new File(context.getFilesDir(), "announcements_audio");
            if (!audioDir.exists()) audioDir.mkdirs();

            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;

            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.getJSONObject(i);
                String id = item.optString("id");
                String name = item.optString("name");
                boolean enabled = item.optBoolean("enabled", true);

                if (id == null || id.isEmpty()) continue;

                // Every sync replaces this announcement's pending alarms so removed times
                // and old recurrence settings cannot continue firing.
                cancelAlarm(id);

                String b64 = item.optString("wavBase64");
                File targetFile = new File(audioDir, id + ".wav");
                if (b64 != null && !b64.isEmpty()) {
                    try {
                        byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                        FileOutputStream fos = new FileOutputStream(targetFile);
                        fos.write(bytes);
                        fos.close();
                    } catch (Exception ignored) {}
                }

                if (!enabled) {
                    cancelAlarm(id);
                    continue;
                }

                JSONArray times = item.optJSONArray("times");
                if (times != null) {
                    for (int t = 0; t < times.length(); t++) {
                        String time = times.getString(t);
                        scheduleAlarmForTime(item, id, name, time, targetFile.getAbsolutePath(), t);
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    @JavascriptInterface
    public void playAnnouncementNow(String id, String name, String wavBase64) {
        try {
            File audioDir = new File(context.getFilesDir(), "announcements_audio");
            if (!audioDir.exists()) audioDir.mkdirs();
            File targetFile = new File(audioDir, (id != null ? id : "manual") + ".wav");
            if (wavBase64 != null && !wavBase64.isEmpty()) {
                byte[] bytes = Base64.decode(wavBase64, Base64.DEFAULT);
                FileOutputStream fos = new FileOutputStream(targetFile);
                fos.write(bytes);
                fos.close();
            }

            Intent intent = new Intent(context, AnnouncementReceiver.class);
            intent.setAction(AnnouncementReceiver.ACTION_ALARM);
            intent.putExtra("id", id);
            intent.putExtra("name", name);
            intent.putExtra("audioPath", targetFile.getAbsolutePath());
            context.sendBroadcast(intent);
        } catch (Exception ignored) {}
    }

    private void scheduleAlarmForTime(JSONObject item, String id, String name, String timeStr, String audioPath, int index) {
        long triggerAtMillis = nextOccurrenceMillis(item, timeStr);
        if (triggerAtMillis <= 0) return;
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) return;

        Intent intent = new Intent(context, AnnouncementReceiver.class);
        intent.setAction(AnnouncementReceiver.ACTION_ALARM);
        intent.putExtra("id", id);
        intent.putExtra("name", name);
        intent.putExtra("audioPath", audioPath);

        int requestCode = (id + "_" + index).hashCode() & 0x7fffffff;
        PendingIntent pi = PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pi);
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, triggerAtMillis, pi);
        }
    }

    private long nextOccurrenceMillis(JSONObject item, String timeStr) {
        try {
            LocalTime time = LocalTime.parse(timeStr.trim());
            ZoneId zone;
            try { zone = ZoneId.of(item.optString("timezone", ZoneId.systemDefault().getId())); }
            catch (Exception ignored) { zone = ZoneId.systemDefault(); }
            LocalDate today = LocalDate.now(zone);
            String schedule = item.optString("schedule", "daily");
            String startText = item.optString("startDate", "");
            String endText = item.optString("endDate", "");
            String onceText = item.optString("date", startText);
            LocalDate start = startText.isEmpty() ? today : LocalDate.parse(startText);
            LocalDate end = endText.isEmpty() ? null : LocalDate.parse(endText);
            LocalDate once = onceText.isEmpty() ? start : LocalDate.parse(onceText);
            int interval = Math.max(1, item.optInt("interval", 1));
            JSONArray days = item.optJSONArray("days");
            long now = System.currentTimeMillis();

            for (int offset = 0; offset <= 3660; offset++) {
                LocalDate date = today.plusDays(offset);
                if (date.isBefore(start) || (end != null && date.isAfter(end))) continue;

                boolean matches;
                if ("once".equals(schedule)) {
                    matches = date.equals(once);
                } else if ("weekly".equals(schedule)) {
                    matches = includesWeekday(days, date.getDayOfWeek().getValue() % 7);
                } else if ("interval".equals(schedule)) {
                    long elapsed = ChronoUnit.DAYS.between(start, date);
                    matches = elapsed >= 0 && elapsed % interval == 0;
                } else {
                    matches = true;
                }

                if (!matches) continue;
                long candidate = date.atTime(time).atZone(zone).toInstant().toEpochMilli();
                if (candidate > now) return candidate;
            }
        } catch (Exception ignored) {}
        return -1L;
    }

    private boolean includesWeekday(JSONArray days, int weekday) {
        if (days == null) return false;
        for (int i = 0; i < days.length(); i++) {
            if (days.optInt(i, -1) == weekday) return true;
        }
        return false;
    }

    private void cancelAlarm(String id) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        for (int i = 0; i < 50; i++) {
            Intent intent = new Intent(context, AnnouncementReceiver.class);
            intent.setAction(AnnouncementReceiver.ACTION_ALARM);
            int requestCode = (id + "_" + i).hashCode() & 0x7fffffff;
            PendingIntent pi = PendingIntent.getBroadcast(
                    context,
                    requestCode,
                    intent,
                    PendingIntent.FLAG_NO_CREATE | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0)
            );
            if (pi != null) {
                am.cancel(pi);
                pi.cancel();
            }
        }
    }

    public static void restoreAlarms(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        String json = prefs.getString(KEY_SCHEDULES, null);
        if (json != null) {
            new AnnouncementBridge(context).syncAnnouncements(json);
        }
    }
}
