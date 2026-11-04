# GYMEG Android — management and members

GYMEG Members: `com.pushtorq.members`, `/member`. GYMEG Manager: `com.pushtorq.management`, `/clubs`. GYMEG Support: `com.gymos.support`, `/platform`. Firebase Messaging is added to all three Gradle app targets. The Firebase project is `gymeg-mobile-notifications` (sender ID `744394281001`). Current source versions are Manager/Members 1.1.6 (versionCode 8) and Support 1.0.5 (versionCode 6). Android 8+ and internet are required. iPhone continues to use the Safari Home Screen web app.

The current certificate is pinned in docs/identity/android-signing-certificates.json. The private key and recovery record are kept outside the repository, APKs and public delivery archive. Keep a separate owner-only backup; future updates to these packages must retain this signing key and increment versionCode.

Firebase build: the checked-in `google-services.json` files are public Android client configuration and each matches its app ID/package; they contain no service-account private key. Install Gradle 8.x, JDK 17+, and Android SDK platform/build tools 36, then run `./build-firebase.ps1`. This builds all three apps with Firebase Messaging. It does not sign or publish APKs. The legacy `python mobile-android/build.py` build does not include Firebase SDK and must not be used for FCM-enabled APKs.

Manager camera access requires runtime consent and the trusted origin. The apps store FCM tokens locally; Manager/Members upload them only after the signed-in user enables alerts. Support enrollment is user-scoped. Native notification routes are restricted to the trusted GymEG origin, and no private chat text is included in FCM payloads. The apps have no file/content access, SSL bypass, third-party cookies, WebView debugging or app-data backup.

Firebase Gradle debug builds succeeded locally for all three apps. Real-device installation and push delivery have not been verified. The public Firebase client files are included in source; the sender credential is stored only as a sensitive Vercel variable. Production sending still requires deploying this source and exercising delivery on a physical Android device. The existing custom Android compiler does not support Firebase dependencies; use the Gradle build above.

References: https://developer.android.com/tools/apksigner and https://developer.android.com/tools/aapt2
