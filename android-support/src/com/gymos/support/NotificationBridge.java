package com.gymos.support;

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

/** Native permission, registration-token, and foreground notification routes for the trusted support WebView. */
final class NotificationBridge {
 private static final int REQUEST_CODE=7305;
 private static final String CHANNEL="gymeg_support",HOST="gymeg.vercel.app";
 static WebResourceResponse intercept(Activity activity,Uri uri){
  if(!trusted(uri))return null;String path=uri.getPath();
  if("/__native_fcm_token__".equals(path)){String token=activity.getSharedPreferences("gymeg_fcm",Context.MODE_PRIVATE).getString("token","");return token.isEmpty()?new WebResourceResponse("application/json","UTF-8",404,"Not Ready",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream("{\"token\":null}".getBytes(java.nio.charset.StandardCharsets.UTF_8))):response("{\"token\":"+org.json.JSONObject.quote(token)+"}");}
  if("/__native_notifications_permission__".equals(path)){boolean granted=Build.VERSION.SDK_INT<33||activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED;boolean requested=!granted;activity.runOnUiThread(()->{if(requested)activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},REQUEST_CODE);else createChannel(activity);});return response("{\"ok\":true,\"granted\":"+granted+",\"requested\":"+requested+"}");}
  if("/__native_notifications__".equals(path)){String title=clean(uri.getQueryParameter("title"),100),body=clean(uri.getQueryParameter("body"),240);activity.runOnUiThread(()->show(activity,title,body));return response("{\"ok\":true}");}
  return null;
 }
 private static boolean trusted(Uri u){return u!=null&&"https".equals(u.getScheme())&&HOST.equalsIgnoreCase(u.getHost())&&(u.getPort()==-1||u.getPort()==443)&&u.getUserInfo()==null;}
 private static String clean(String v,int n){if(v==null)return "GymEG Support";String s=v.replaceAll("[\\p{Cntrl}]"," ").trim();return s.length()>n?s.substring(0,n):s;}
 private static WebResourceResponse response(String s){return new WebResourceResponse("application/json","UTF-8",200,"OK",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(s.getBytes(java.nio.charset.StandardCharsets.UTF_8)));}
 private static void createChannel(Activity a){if(Build.VERSION.SDK_INT>=26){NotificationManager m=(NotificationManager)a.getSystemService(Context.NOTIFICATION_SERVICE);if(m!=null)m.createNotificationChannel(new NotificationChannel(CHANNEL,"تنبيهات الدعم / Support alerts",NotificationManager.IMPORTANCE_HIGH));}}
 private static void show(Activity a,String title,String body){if(Build.VERSION.SDK_INT>=33&&a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return;createChannel(a);NotificationManager m=(NotificationManager)a.getSystemService(Context.NOTIFICATION_SERVICE);if(m==null)return;Intent i=new Intent(a,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);PendingIntent p=PendingIntent.getActivity(a,2,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);m.notify((int)(System.currentTimeMillis()&0x7fffffff),new Notification.Builder(a,CHANNEL).setSmallIcon(R.drawable.ic_launcher_foreground).setContentTitle(title).setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body)).setContentIntent(p).setAutoCancel(true).build());}
}
