package com.gymos.management;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import java.io.File;

public final class AnnouncementReceiver extends BroadcastReceiver {
    public static final String ACTION_ALARM = "com.gymos.management.ANNOUNCEMENT_ALARM";
    public static final String CHANNEL_ID = "gymeg_announcements_channel";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            // Restore alarms on reboot
            AnnouncementBridge.restoreAlarms(context);
            return;
        }

        if (!ACTION_ALARM.equals(intent.getAction())) return;

        final String id = intent.getStringExtra("id");
        final String name = intent.getStringExtra("name");
        final String audioPath = intent.getStringExtra("audioPath");

        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = null;
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GymEG:AnnouncementWakeLock");
            wakeLock.acquire(35000); // Max 35s wake lock (well within our 30s audio limit)
        }

        final PowerManager.WakeLock finalLock = wakeLock;

        // Try playing native audio file directly if cached
        if (audioPath != null && new File(audioPath).exists()) {
            try {
                final MediaPlayer player = new MediaPlayer();
                player.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                player.setDataSource(audioPath);
                player.prepare();
                player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                    @Override
                    public void onCompletion(MediaPlayer mp) {
                        try { mp.release(); } catch (Exception ignored) {}
                        if (finalLock != null && finalLock.isHeld()) {
                            finalLock.release();
                        }
                    }
                });
                player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                    @Override
                    public boolean onError(MediaPlayer mp, int what, int extra) {
                        try { mp.release(); } catch (Exception ignored) {}
                        if (finalLock != null && finalLock.isHeld()) {
                            finalLock.release();
                        }
                        return false;
                    }
                });
                player.start();
            } catch (Exception e) {
                if (finalLock != null && finalLock.isHeld()) {
                    finalLock.release();
                }
            }
        } else {
            if (finalLock != null && finalLock.isHeld()) {
                finalLock.release();
            }
        }

        // Post high-priority notification to ensure visibility on lock screen
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "نداءات النادي الصوتية / Club Announcements",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("تشغيل وتنبيهات النداءات المجدولة في الصالة");
            channel.enableVibration(true);
            channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(channel);
        }

        Intent openIntent = new Intent(context, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                context,
                id != null ? id.hashCode() : 0,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        android.app.Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new android.app.Notification.Builder(context, CHANNEL_ID);
        } else {
            builder = new android.app.Notification.Builder(context);
        }

        builder.setContentTitle(name != null && !name.isEmpty() ? name : "نداء صوتي مجدول")
                .setContentText("موعد النداء الصوتي في الصالة")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(android.app.Notification.PRIORITY_MAX);

        nm.notify(id != null ? id.hashCode() : (int) System.currentTimeMillis(), builder.build());
    }
}
