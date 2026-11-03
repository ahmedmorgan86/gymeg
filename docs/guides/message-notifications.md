# Club message alerts / تنبيهات رسائل النادي

## What the current release does

- **Member → club staff:** the management workspace checks for newly received messages every 2.5 seconds and alerts only within the staff member's allowed branch scope. Platform owners can see their authorized cross-club scope.
- **Club staff → member:** the member app checks for new staff replies every 5 seconds. The first load establishes a baseline, so old messages do not appear as new alerts.
- **Web and installed PWA:** if the visitor grants browser notification permission, the service worker displays an operating-system notification while the page is receiving updates. The user must keep the app open; browsers may throttle background tabs.
- **Android Manager and Members apps:** the app asks for Android notification permission and displays native notifications through two exact, same-origin local URL intercepts. No JavaScript interface is exposed to the WebView. The app must remain running and its page active to receive chat updates.
- **Windows app:** a new chat message plays the Windows system alert sound and flashes the app on the taskbar. The in-app notification center also lists the message and opens its conversation.
- **iPhone/iPad Safari:** browser notifications are requested where Safari supports them. The site must be installed as a web app on supported iOS versions for web push capabilities; this release uses page polling, not remote push.

## Enable notifications

1. Sign in and open **Club messages / رسائل النادي** (or the notification center for staff).
2. Press **Enable message alerts / تفعيل تنبيهات الرسائل**.
3. Approve the permission prompt. If it was previously blocked, enable notifications in the browser or phone settings.
4. Leave GymEG open and signed in. Alerts are limited by the current club, branch, and account permissions.

## Delivery limits

This is an in-app polling and local-notification implementation. It is not a remote push service: no alert is guaranteed while the website/app is closed, the device is offline, or Android has suspended/force-stopped the app. Reliable closed-app delivery needs a server push service (Web Push/VAPID and an APNs/FCM delivery path), persisted device subscriptions, expiry handling, and provider configuration. A real device test is still required for each browser/OS notification prompt and Windows taskbar behavior.
