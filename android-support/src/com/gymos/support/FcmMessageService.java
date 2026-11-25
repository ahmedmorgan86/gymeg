package com.gymos.support;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** FCM receiver for generic platform support alerts. */
public final class FcmMessageService extends FirebaseMessagingService {
 private static final String CHANNEL="gymeg_support";
 @Override public void onNewToken(String token){getSharedPreferences("gymeg_fcm",MODE_PRIVATE).edit().putString("token",token).apply();}
 @Override public void onMessageReceived(RemoteMessage message){
  if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return;
  NotificationManager manager=(NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);if(manager==null)return;
  if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(new NotificationChannel(CHANNEL,"تنبيهات الدعم / Support alerts",NotificationManager.IMPORTANCE_HIGH));
  String tag=message.getNotification()!=null?message.getNotification().getTag():null;
  if((tag==null||tag.isEmpty())&&message.getData()!=null)tag=message.getData().get("tag");
  String path=message.getData()==null?"":message.getData().get("url");String url="/support-requests".equals(path)||"/platform".equals(path)?path:"/platform";
  Intent intent=new Intent(this,MainActivity.class).setAction("com.gymos.support.OPEN_FCM").putExtra("gymeg_url",url).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
  PendingIntent pending=PendingIntent.getActivity(this,2,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
  Notification notification=new NotificationCompat.Builder(this,CHANNEL).setSmallIcon(R.drawable.ic_launcher_foreground).setContentTitle("GymEG Support").setContentText("لديك تنبيه دعم جديد / New support alert").setContentIntent(pending).setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH).setOnlyAlertOnce(true).build();
  if(tag==null||tag.isEmpty())manager.notify((int)(System.currentTimeMillis()&0x7fffffff),notification);
  else manager.notify(tag,0,notification);
 }
}
