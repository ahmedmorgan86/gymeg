package com.pushtorq.management;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.util.Collections;

/** Intercepts two fixed same-origin URLs locally; this is not a JavaScript interface. */
final class NotificationBridge {
 private static final int REQUEST_CODE=7303;
 private static final String CHANNEL="gymeg_messages",HOST=BuildConfig.WEB_HOST;
 static WebResourceResponse intercept(Activity activity,Uri uri){if(!trusted(uri))return null;String path=uri.getPath();if("/__native_fcm_token__".equals(path)){String token=activity.getSharedPreferences("gymeg_fcm",Context.MODE_PRIVATE).getString("token","");return token.isEmpty()?new WebResourceResponse("application/json","UTF-8",404,"Not Ready",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream("{\"token\":null}".getBytes(java.nio.charset.StandardCharsets.UTF_8))):response("{\"token\":"+org.json.JSONObject.quote(token)+"}");}if("/__native_notifications_permission__".equals(path)){boolean granted=Build.VERSION.SDK_INT<33||activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED;boolean requested=!granted;activity.runOnUiThread(new Runnable(){@Override public void run(){if(requested)activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},REQUEST_CODE);else createChannel(activity);}});return response("{\"ok\":true,\"granted\":"+granted+",\"requested\":"+requested+"}");}if("/__native_notifications__".equals(path)){String title=clean(uri.getQueryParameter("title"),100),body=clean(uri.getQueryParameter("body"),240);activity.runOnUiThread(new Runnable(){@Override public void run(){show(activity,title,body);}});return response("{\"ok\":true}");}return null;}
 private static boolean trusted(Uri uri){return uri!=null&&"https".equals(uri.getScheme())&&HOST.equalsIgnoreCase(uri.getHost())&&(uri.getPort()==-1||uri.getPort()==443)&&uri.getUserInfo()==null;}
 private static String clean(String value,int limit){if(value==null)return "GymEG";String safe=value.replaceAll("[\\p{Cntrl}]"," ").trim();return safe.length()>limit?safe.substring(0,limit):safe;}
 private static WebResourceResponse response(String value){return new WebResourceResponse("application/json","UTF-8",200,"OK",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)));}
 private static void createChannel(Activity activity){if(Build.VERSION.SDK_INT>=26){NotificationManager manager=(NotificationManager)activity.getSystemService(Context.NOTIFICATION_SERVICE);if(manager!=null)manager.createNotificationChannel(new NotificationChannel(CHANNEL,"رسائل النادي / Club messages",NotificationManager.IMPORTANCE_HIGH));}}
 private static void show(Activity activity,String title,String body){if(Build.VERSION.SDK_INT>=33&&activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return;createChannel(activity);NotificationManager manager=(NotificationManager)activity.getSystemService(Context.NOTIFICATION_SERVICE);if(manager==null)return;Intent intent=new Intent(activity,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);PendingIntent tap=PendingIntent.getActivity(activity,0,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);Notification notification=new Notification.Builder(activity,CHANNEL).setSmallIcon(R.drawable.ic_launcher_foreground).setContentTitle(title).setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body)).setContentIntent(tap).setAutoCancel(true).build();manager.notify((int)(System.currentTimeMillis()&0x7fffffff),notification);}
}
