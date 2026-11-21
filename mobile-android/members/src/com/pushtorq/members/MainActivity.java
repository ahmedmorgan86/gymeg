package com.pushtorq.members;
import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.io.ByteArrayInputStream;

/** Member-only HTTPS shell. Native notifications use strict URL interception, not a JS bridge. */
public final class MainActivity extends Activity {
 private static final String HOST=BuildConfig.WEB_HOST;
 private static final String HOME="https://"+HOST+"/member";
 private android.widget.ImageView splash; private WebView web; private ProgressBar progress; private LinearLayout error;
 private static boolean trusted(Uri uri){return uri!=null&&"https".equals(uri.getScheme())&&HOST.equalsIgnoreCase(uri.getHost())&&(uri.getPort()==-1||uri.getPort()==443)&&uri.getUserInfo()==null;}
 private static boolean memberPage(Uri uri){String path=uri.getPath();return trusted(uri)&&path!=null&&(path.equals("/member")||path.startsWith("/member/"));}
 // Google sign-in runs in the system browser (Chrome cookies, not the
 // WebView's). The app sends only a SHA-256 challenge here; the matching
 // verifier stays in memory and is presented once at the handoff exchange.
 private static final String OAUTH_CLIENT="android-members";
 // singleTask delivers the App Link to THIS activity via onNewIntent, and the
 // pending verifier lives in app-private prefs: an activity recreation or
 // process death during the system-browser flow no longer loses the proof.
 // Entries are single-use and expire with the server-side flow (10 minutes).
 private static final String OAUTH_PREFS="gymeg_oauth",PENDING_VERIFIER="pending_verifier",PENDING_AT="pending_at";
 private static final long PENDING_TTL_MS=600000L;
 private static boolean oauthStart(Uri uri){return trusted(uri)&&"/api/auth/google".equals(uri.getPath());}
 private static boolean handoffLink(Uri uri){return trusted(uri)&&"/auth/mobile/callback".equals(uri.getPath());}
 private static String newVerifier(){byte[] b=new byte[32];new java.security.SecureRandom().nextBytes(b);return android.util.Base64.encodeToString(b,android.util.Base64.URL_SAFE|android.util.Base64.NO_WRAP|android.util.Base64.NO_PADDING);}
 private static String sha256Base64Url(String s){try{return android.util.Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(s.getBytes("UTF-8")),android.util.Base64.URL_SAFE|android.util.Base64.NO_WRAP|android.util.Base64.NO_PADDING);}catch(Exception e){return "";}}
 private void openExternal(Uri uri){if(uri==null||!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||(uri.getPort()!=-1&&uri.getPort()!=443))return;try{startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,uri));}catch(Exception e){android.widget.Toast.makeText(this,"تعذر فتح الرابط / Cannot open link",android.widget.Toast.LENGTH_LONG).show();}}
 private void savePendingVerifier(String v){getSharedPreferences(OAUTH_PREFS,MODE_PRIVATE).edit().putString(PENDING_VERIFIER,v).putLong(PENDING_AT,System.currentTimeMillis()).apply();}
 // The proof is read without deleting: a malformed or unrelated intent, or a
 // failed exchange, must never cancel an in-flight sign-in. It is cleared
 // only after a successful bound exchange, and only if it still matches (a
 // stale response cannot erase a newer flow's proof).
 private String readPendingVerifier(){android.content.SharedPreferences p=getSharedPreferences(OAUTH_PREFS,MODE_PRIVATE);String v=p.getString(PENDING_VERIFIER,null);long at=p.getLong(PENDING_AT,0);if(v==null)return null;if(System.currentTimeMillis()-at>PENDING_TTL_MS){p.edit().remove(PENDING_VERIFIER).remove(PENDING_AT).apply();return null;}return v;}
 private void clearPendingVerifierIfMatches(String v){android.content.SharedPreferences p=getSharedPreferences(OAUTH_PREFS,MODE_PRIVATE);if(v.equals(p.getString(PENDING_VERIFIER,null)))p.edit().remove(PENDING_VERIFIER).remove(PENDING_AT).apply();}
 private void startOAuth(Uri uri){String verifier=newVerifier();savePendingVerifier(verifier);Uri out=uri.buildUpon().appendQueryParameter("client",OAUTH_CLIENT).appendQueryParameter("hc",sha256Base64Url(verifier)).build();openExternal(out);}
 // Returns true when the intent carried a handoff link (whether or not the
 // exchange later succeeds); the caller then skips the default loadHome().
 private boolean handleHandoffIntent(android.content.Intent intent){if(intent==null)return false;Uri uri=intent.getData();if(uri==null||!handoffLink(uri))return false;intent.setData(null);String code=uri.getQueryParameter("code");String client=uri.getQueryParameter("client");if(code==null||!code.matches("[A-Za-z0-9_-]{43}")||!OAUTH_CLIENT.equals(client)){web.loadUrl("https://"+HOST+"/sign-in?error=google_failed");return true;}final String verifier=readPendingVerifier();if(verifier==null){web.loadUrl("https://"+HOST+"/sign-in?error=google_failed");return true;}exchange(code,verifier);return true;}
 private void exchange(final String code,final String verifier){new Thread(new Runnable(){@Override public void run(){try{java.net.HttpURLConnection c=(java.net.HttpURLConnection)new java.net.URL("https://"+HOST+"/api/auth/mobile/exchange").openConnection();c.setRequestMethod("POST");c.setRequestProperty("Content-Type","application/json");c.setDoOutput(true);c.setConnectTimeout(15000);c.setReadTimeout(15000);String body="{\"code\":\""+code+"\",\"verifier\":\""+verifier+"\",\"client\":\""+OAUTH_CLIENT+"\"}";c.getOutputStream().write(body.getBytes("UTF-8"));int status=c.getResponseCode();final String cookie=c.getHeaderField("Set-Cookie");c.disconnect();if(status==204&&cookie!=null&&cookie.startsWith("gymos_session=")){runOnUiThread(new Runnable(){@Override public void run(){CookieManager.getInstance().setCookie("https://"+HOST,cookie,new android.webkit.ValueCallback<Boolean>(){@Override public void onReceiveValue(Boolean accepted){if(Boolean.TRUE.equals(accepted)){clearPendingVerifierIfMatches(verifier);CookieManager.getInstance().flush();loadHome();}else{web.loadUrl("https://"+HOST+"/sign-in?error=google_failed");}}});}});}else{runOnUiThread(new Runnable(){@Override public void run(){web.loadUrl("https://"+HOST+"/sign-in?error=google_failed");}});}}catch(Exception e){runOnUiThread(new Runnable(){@Override public void run(){web.loadUrl("https://"+HOST+"/sign-in?error=google_failed");}});}}}).start();}
 @Override public void onCreate(Bundle state){super.onCreate(state);
  getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
  FrameLayout root=new FrameLayout(this);root.setBackgroundColor(Color.rgb(18,16,28));setContentView(root);
  if(android.os.Build.VERSION.SDK_INT>=30){getWindow().setDecorFitsSystemWindows(false);root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener(){@Override public WindowInsets onApplyWindowInsets(View v,WindowInsets insets){android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());v.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;}});}
  web=new WebView(this);root.addView(web,new FrameLayout.LayoutParams(-1,-1));
  progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);FrameLayout.LayoutParams pp=new FrameLayout.LayoutParams(-1,8);pp.gravity=android.view.Gravity.TOP;root.addView(progress,pp);progress.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.rgb(168,85,247)));
  splash=new android.widget.ImageView(this);splash.setImageResource(R.drawable.logo);int logoSize=(int)(128*getResources().getDisplayMetrics().density);root.addView(splash,new FrameLayout.LayoutParams(logoSize,logoSize,android.view.Gravity.CENTER));
  error=new LinearLayout(this);error.setOrientation(LinearLayout.VERTICAL);error.setGravity(android.view.Gravity.CENTER);error.setPadding(40,40,40,40);error.setBackgroundColor(Color.rgb(18,16,28));
  TextView title=new TextView(this);title.setText("تعذر الاتصال بالنادي\nCheck your internet connection");title.setTextSize(21);title.setTextColor(Color.rgb(245,243,255));title.setGravity(android.view.Gravity.CENTER);error.addView(title);
  Button retry=new Button(this);retry.setText("إعادة المحاولة / Retry");retry.setOnClickListener(new View.OnClickListener(){@Override public void onClick(View v){loadHome();}});error.addView(retry);error.setVisibility(View.GONE);root.addView(error,new FrameLayout.LayoutParams(-1,-1));
  WebView.setWebContentsDebuggingEnabled(false);WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setSafeBrowsingEnabled(true);settings.setSupportMultipleWindows(false);settings.setJavaScriptCanOpenWindowsAutomatically(false);settings.setMediaPlaybackRequiresUserGesture(false);settings.setUserAgentString(settings.getUserAgentString()+" GymEGMembersAndroid/1.1.8");
  CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
  web.setWebChromeClient(new WebChromeClient(){@Override public void onProgressChanged(WebView v,int value){if(value==100&&splash!=null)splash.setVisibility(View.GONE);progress.setProgress(value);progress.setVisibility(value<100?View.VISIBLE:View.GONE);}});
  web.setWebViewClient(new WebViewClient(){
   @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest request){if(oauthStart(request.getUrl())){startOAuth(request.getUrl());return true;}if(trusted(request.getUrl())&&request.getUrl().getPath()!=null&&request.getUrl().getPath().endsWith(".apk")){android.widget.Toast.makeText(MainActivity.this,"تطبيق Android مثبت بالفعل / Android app is already installed",android.widget.Toast.LENGTH_LONG).show();return true;}return !memberPage(request.getUrl());}
   @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest request){Uri u=request.getUrl();WebResourceResponse notification=NotificationBridge.intercept(MainActivity.this,u);if(notification!=null)return notification;String asset=u.toString();if(trusted(u)||asset.startsWith("blob:https://"+HOST+"/")||(asset.length()<8000000&&(asset.startsWith("data:image/png;base64,")||asset.startsWith("data:image/jpeg;base64,")||asset.startsWith("data:image/webp;base64,")||asset.startsWith("data:audio/wav;base64,")||asset.startsWith("data:audio/mpeg;base64,")||asset.startsWith("data:audio/mp3;base64,")||asset.startsWith("data:audio/ogg;base64,"))))return null;return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",java.util.Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
   @Override public void onReceivedError(WebView v,WebResourceRequest request,WebResourceError e){if(request.isForMainFrame())showError();}
   @Override public void onReceivedHttpError(WebView v,WebResourceRequest request,WebResourceResponse response){if(request.isForMainFrame()&&response.getStatusCode()>=400)showError();}
   @Override public void onReceivedSslError(WebView v,SslErrorHandler handler,SslError e){handler.cancel();showError();}
   @Override public boolean onRenderProcessGone(WebView v,android.webkit.RenderProcessGoneDetail detail){((ViewGroup)v.getParent()).removeView(v);v.destroy();web=null;recreate();return true;}
  });
  // Never restore an externally supplied URL or save HTML/account data in the activity bundle.
  if(android.os.Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,new android.window.OnBackInvokedCallback(){@Override public void onBackInvoked(){handleBack();}});
  refreshFcmToken();if(!handleHandoffIntent(getIntent()))loadHome();
 }
 private void refreshFcmToken(){try{com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token->getSharedPreferences("gymeg_fcm",MODE_PRIVATE).edit().putString("token",token).apply());}catch(Exception ignored){}}
 private void loadHome(){error.setVisibility(View.GONE);web.setVisibility(View.VISIBLE);web.loadUrl(HOME);}
 @Override protected void onNewIntent(android.content.Intent intent){super.onNewIntent(intent);setIntent(intent);if(intent==null)return;if(handleHandoffIntent(intent))return;if("com.pushtorq.members.OPEN_FCM".equals(intent.getAction()))loadHome();}
 private void showError(){if(splash!=null)splash.setVisibility(View.GONE);runOnUiThread(new Runnable(){@Override public void run(){progress.setVisibility(View.GONE);web.setVisibility(View.GONE);error.setVisibility(View.VISIBLE);}});}
 private void handleBack(){if(web!=null&&web.canGoBack())web.goBack();else finish();}
 @Override public void onBackPressed(){handleBack();}
 @Override protected void onPause(){CookieManager.getInstance().flush();if(web!=null){web.onPause();web.pauseTimers();}super.onPause();}
 @Override protected void onResume(){super.onResume();if(web!=null){web.resumeTimers();web.onResume();}}
 @Override protected void onDestroy(){if(web!=null){web.stopLoading();((ViewGroup)web.getParent()).removeView(web);web.destroy();}super.onDestroy();}
}
