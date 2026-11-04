import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shouldRunBrowserAnnouncementScheduler} from '../app/lib/announcement-runtime.ts';

test('native host schedules announcements instead of the browser timer',()=>{
 assert.equal(shouldRunBrowserAnnouncementScheduler({windows:true,androidBridge:false,ios:false,userAgent:'WebView'}),false);
 assert.equal(shouldRunBrowserAnnouncementScheduler({windows:false,androidBridge:true,ios:false,userAgent:'WebView'}),false);
 assert.equal(shouldRunBrowserAnnouncementScheduler({windows:false,androidBridge:false,ios:false,userAgent:'Mozilla/5.0 GymEGManagerAndroid/1.1.7'}),false);
 assert.equal(shouldRunBrowserAnnouncementScheduler({windows:false,androidBridge:false,ios:true,userAgent:'WebKit'}),false);
});

test('ordinary mobile and desktop browsers retain the foreground scheduler',()=>{
 assert.equal(shouldRunBrowserAnnouncementScheduler({windows:false,androidBridge:false,ios:false,userAgent:'Mozilla/5.0 Android Chrome'}),true);
 assert.equal(shouldRunBrowserAnnouncementScheduler({windows:false,androidBridge:false,ios:false,userAgent:'Mozilla/5.0 Chrome'}),true);
});
