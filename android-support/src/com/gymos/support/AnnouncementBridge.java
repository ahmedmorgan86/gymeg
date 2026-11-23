package com.gymos.support;

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
import java.util.Calendar;

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
            prefs.edit().putString(KEY_SCHEDULES, jsonString).apply();

            JSONArray array = new JSONArray(jsonString);
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
                        scheduleAlarmForTime(id, name, time, targetFile.getAbsolutePath(), t);
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

    private void scheduleAlarmForTime(String id, String name, String timeStr, String audioPath, int index) {
        String[] parts = timeStr.trim().split(":");
        if (parts.length != 2) return;

        int hour = Integer.parseInt(parts[0].trim());
        int minute = Integer.parseInt(parts[1].trim());

        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, hour);
        cal.set(Calendar.MINUTE, minute);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);

        if (cal.getTimeInMillis() <= System.currentTimeMillis()) {
            cal.add(Calendar.DAY_OF_YEAR, 1);
        }

        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        Intent intent = new Intent(context, AnnouncementReceiver.class);
        intent.setAction(AnnouncementReceiver.ACTION_ALARM);
        intent.putExtra("id", id);
        intent.putExtra("name", name);
        intent.putExtra("audioPath", audioPath);

        int requestCode = Math.abs((id + "_" + index).hashCode());
        PendingIntent pi = PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
        }
    }

    private void cancelAlarm(String id) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        for (int i = 0; i < 50; i++) {
            Intent intent = new Intent(context, AnnouncementReceiver.class);
            intent.setAction(AnnouncementReceiver.ACTION_ALARM);
            int requestCode = Math.abs((id + "_" + i).hashCode());
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
