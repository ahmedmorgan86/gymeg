# GYMEG Android — management and members

GYMEG Members: com.pushtorq.members, /member. GYMEG Manager: com.pushtorq.management, /clubs. Current version 1.1.5, versionCode 7. Android 8+ and internet are required. Both target https://gymeg.vercel.app and the existing cloud accounts/data. Package IDs remain stable technical identifiers. The owner authorized a replacement signing certificate because the previous private certificate was unavailable. Sync pending work, uninstall the previous signed APK, install GYMEG 1.1.5, and sign in with the existing account. iPhone uses the Safari Home Screen web app. No store publication is included.

The current certificate is pinned in docs/identity/android-signing-certificates.json. The private key and recovery record are kept outside the repository, APKs and public delivery archive. Keep a separate owner-only backup; future updates to these packages must retain this signing key and increment versionCode.

Build: python mobile-android/build.py. Requires official SDK Build Tools, platform 36 and a JDK with jdk.compiler. Set ANDROID_BUILD_TOOLS to the SDK tools folder, ANDROID_PLATFORM_JAR to android.jar, GYMEG_KEYSTORE to the external private PKCS12 file, GYMEG_KEYSTORE_PASSWORD securely through environment and optionally GYMEG_KEY_ALIAS and JAVA. Historical PUSHTORQ_* variables remain supported for existing build automation. Set the alias belonging to the GYMEG key. Native libraries must be discoverable. The builder compiles resources and Java, creates DEX, aligns before signing, verifies signature/alignment and records source hashes.

Manager camera access requires runtime consent and the trusted origin. Members and Manager request notification permission only when the user enables message alerts. Their limited JavaScript bridge is restricted to displaying local notifications and requesting that notification permission; it exposes no files or account data. Neither app has file/content access, SSL bypass, third-party cookies, WebView debugging or app-data backup.

Verified: compilation, Android apksigner v2/v3 signatures, ZIP alignment, source/artifact hashes and automated security checks. Physical phone/emulator installation, actual account login, camera/barcode operation and Play Protect approval have not been tested. Signing does not guarantee that installation warnings disappear.

References: https://developer.android.com/tools/apksigner and https://developer.android.com/tools/aapt2
