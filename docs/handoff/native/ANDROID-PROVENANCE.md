# Gold APK build provenance , built 2026-11-23, verified 2026-11-23
Values dumped from the actual APKs with aapt2 36.0.0 (badging) and apksigner; hashes are sha256sum of the delivered files.

## Manager , GymEG-Manager-1.1.9.3.apk
- package: com.pushtorq.management.freshtest, versionCode 14, versionName 1.1.9.3
- minSdk 26, targetSdk 36, compileSdk 36
- size 3212996 bytes, sha256 4b2a79d78942afd75c83a2a777aa0b35a48a72bd3f672b6a057eb2a830b5800a
- gradle output finished 2026-11-23 10:36:06 +0200 (manager-gold-release.apk)

## Members , GymEG-Members-1.1.8.3.apk
- package: com.pushtorq.members.freshtest, versionCode 13, versionName 1.1.8.3
- minSdk 26, targetSdk 36, compileSdk 36
- size 3194700 bytes, sha256 0aef1a3009e168cd1534eb2f3398f8d7a15805ee09f76717eee892964b040ddc
- gradle output finished 2026-11-23 10:36:08 +0200 (members-gold-release.apk)

## Support , GymEG-Support-1.0.9.3.apk
- package: com.gymos.support.freshtest, versionCode 13, versionName 1.0.9.3
- minSdk 26, targetSdk 36, compileSdk 36
- size 3190592 bytes, sha256 665443c40b7c8b339e2cf8f3b3977a45bd877047f61d6a6c6361f5e8aa5d146e
- gradle output finished 2026-11-23 10:36:12 +0200 (support-gold-release.apk)

## Common
- Signing cert (all three, apksigner): SHA-256 ce1b7c62… (CE1B vault key gymeg-android-release-signing-key-p256-raw-b64); zipalign verified; apksigner verify passed
- No builtAt timestamp is embedded in the APKs; the build-completion times above are the authoritative provenance
- Source: commit c8734df (chain eb851f4 -> 3c6be35 -> 5fd70954 members dedup -> 714763c manager/support dedup -> c8734df gold flavor+version bump), branch android-gold, bundle android-gold-c8734df.bundle (prereq eb851f4); merged by engineering at fa27d0e, byte-identical Android trees
- Toolchain: JDK 17, Gradle 8.14.3, Android SDK build-tools 36.0.0
- FCM dedup patch compiled into all three (notify(tag,0)+setOnlyAlertOnce)
