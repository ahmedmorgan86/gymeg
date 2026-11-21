import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

for(const role of ['members','management'])test(`Android ${role} handles only trusted-origin notifications without a JS bridge`,()=>{
 const base=new URL(`../mobile-android/${role}/`,import.meta.url);
 const manifest=readFileSync(new URL('AndroidManifest.xml',base),'utf8');
 const main=readFileSync(new URL(`src/com/pushtorq/${role}/MainActivity.java`,base),'utf8');
 const bridge=readFileSync(new URL(`src/com/pushtorq/${role}/NotificationBridge.java`,base),'utf8');
 assert.match(manifest,/android\.permission\.POST_NOTIFICATIONS/);
 assert.match(manifest,role==='management'?/android:versionCode="11" android:versionName="1\.1\.9"/:/android:versionCode="10" android:versionName="1\.1\.8"/);
 assert.doesNotMatch(main,/addJavascriptInterface/);
 assert.match(main,/NotificationBridge\.intercept\(MainActivity\.this,u\)/);
 // The origin is single-sourced: BuildConfig.WEB_HOST from the gradle flavors.
 assert.match(bridge,/BuildConfig\.WEB_HOST/);
 const gradle=readFileSync(new URL('build.gradle',base),'utf8');
 assert.match(gradle,/production[\s\S]*?WEB_HOST', '"gymeg\.vercel\.app"'/);
 assert.match(bridge,/__native_notifications_permission__/);
 assert.match(bridge,/__native_notifications__/);
 assert.match(bridge,/POST_NOTIFICATIONS/);
 assert.match(bridge,/boolean granted=Build\.VERSION\.SDK_INT<33/);
 assert.match(bridge,/boolean requested=!granted/);
 assert.match(bridge,/clean\(uri\.getQueryParameter\("body"\),240\)/);
 assert.doesNotMatch(bridge,/@JavascriptInterface|WebView\.loadUrl|File|Cookie/);
});
