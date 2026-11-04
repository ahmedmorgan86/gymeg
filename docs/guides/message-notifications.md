# Club message alerts / تنبيهات رسائل النادي

## Current behavior / السلوك الحالي

- **Member → club / العضو ← النادي:** member messages are saved first. A generic push is then sent to registered owner/manager devices in the member's own branch. Staff replies send a generic push to the addressed member only. Push payloads never contain the chat text, member name, or other private details.
- **Web/PWA:** browser push subscriptions are encrypted at rest using AES-256-GCM; only their SHA-256 endpoint digest is indexed. Push registration is tied to the authenticated member or the signed-in owner/manager, tenant and branch. Endpoints are restricted to supported browser push providers. Expired provider endpoints (404/410) are removed.
- **iPhone/iPad:** standards-based web push works on supported iOS/iPadOS versions after the GymEG web app is added to the Home Screen and notification permission is granted. Opening the website in an ordinary tab is not enough on supported iOS releases.
- **Android native wrappers:** Manager, Members and Support have Firebase Messaging services, package-specific Gradle configuration and a native token route. Club chat tokens are encrypted at rest and scoped to tenant, branch and signed-in recipient; support tokens use a separate user-scoped table. The Firebase project and Android apps are registered. Token enrollment can work with the encryption key; actual FCM delivery additionally requires the limited server credential in Vercel, deployed source, and an installed build tested on a real device.
- **Windows:** the Windows shell can show foreground/local alerts; browser Web Push behavior inside the packaged WebView must be verified on each supported WebView2 runtime before claiming background push support.
- **Legacy polling/local alerts:** while signed in and the app page is active, message polling and local notifications remain available as a fallback.

## Server configuration / إعداد الخادم

The following are server-only Vercel variables. Never add the private VAPID key or encryption key to a `NEXT_PUBLIC_*` variable, Android asset, repository, or client bundle:

- `GYMEG_VAPID_PUBLIC_KEY`: VAPID public key generated with the standard `web-push` library.
- `GYMEG_VAPID_PRIVATE_KEY`: matching private key; store as a sensitive secret.
- `GYMEG_VAPID_SUBJECT`: a monitored `mailto:` address or HTTPS contact URL.
- `GYMEG_PUSH_SUBSCRIPTION_KEY`: a random 32-byte key encoded as base64; keep a secure recovery copy separate from the source repository.

Apply `supabase/migrations/20261103121100_push_notification_subscriptions.sql`, `20261103140000_fcm_push_subscriptions.sql`, and `20261103150000_fcm_support_subscriptions.sql` to each target database before deploying matching source. They create tenant/branch and support-user-scoped tables, force RLS, and grant access only to the limited runtime role. The app sets scope through its existing database wrapper. Validate policies and runtime role before production rollout.

FCM server delivery uses sensitive Vercel variable `GYMEG_FIREBASE_SERVICE_ACCOUNT` with the private JSON from the dedicated sender account. Keep it server-only; never place it in `NEXT_PUBLIC_*`, an APK, or Git. The sender project must be `gymeg-mobile-notifications`, and the service account must have only Firebase Cloud Messaging send permissions. `google-services.json` is public Android client configuration with no service-account private key; the repository includes one file for each package ID.

After provisioning Vercel secrets, deploy the matching code and migration together, then test a real member-to-manager and manager-to-member message on separate registered devices. Check permission prompts, browser background delivery, unsubscribe, expired subscriptions, and tenant/branch isolation. Do not use real member message contents for test payloads.

## Enable alerts / تفعيل التنبيهات

1. Sign in and open **Club messages / رسائل النادي** or the staff notification center.
2. Select **Enable message alerts / تفعيل تنبيهات الرسائل** and grant the browser permission.
3. On Android, install a build made with the matching Firebase configuration for that app. Enabling alerts requests native permission and registers the FCM token against the active signed-in user and branch. Staff must have the owner/manager role and access to that branch; members are bound to their server-authenticated member session.
4. To stop a device, use **Disable alerts / إيقاف التنبيهات**. Browser permission may also need to be revoked in device settings.

## Delivery boundaries / حدود التسليم

Push providers and operating systems may delay or suppress delivery due to battery settings, browser policy, connectivity or expired subscriptions. A successful API response only confirms that the provider accepted a request; it is not proof that a human saw it. Android device delivery and Windows WebView background push remain unverified. Support-device tokens can be enrolled, but a support-event sender has not yet been connected. Never use chat push as the only channel for safety-critical or payment actions.
