# GymEG native release handoff , Android + Windows candidate state (2026-11-24)
Product release-engineering notes. No secrets, key material, customer data, or live-system details. Nothing here is published; every candidate is private.

## 1. Android gold candidates (private, build-verified, NOT device-tested)
Built 2026-11-23 10:36 +0200 from commit c8734df (android-gold chain eb851f4 → 3c6be35 → 5fd70954 → 714763c → c8734df). Toolchain: JDK 17, Gradle 8.14.3, Android SDK build-tools 36.0.0.

| App | File | Package | versionCode / versionName | Bytes | SHA-256 |
|---|---|---|---|---|---|
| Manager | GymEG-Manager-1.1.9.3.apk | com.pushtorq.management.freshtest | 14 / 1.1.9.3 | 3,212,996 | 4b2a79d78942afd75c83a2a777aa0b35a48a72bd3f672b6a057eb2a830b5800a |
| Members | GymEG-Members-1.1.8.3.apk | com.pushtorq.members.freshtest | 13 / 1.1.8.3 | 3,194,700 | 0aef1a3009e168cd1534eb2f3398f8d7a15805ee09f76717eee892964b040ddc |
| Support | GymEG-Support-1.0.9.3.apk | com.gymos.support.freshtest | 13 / 1.0.9.3 | 3,190,592 | 665443c40b7c8b339e2cf8f3b3977a45bd877047f61d6a6c6361f5e8aa5d146e |

All three: minSdk 26, targetSdk 36, zipaligned, apksigner verify passed, signed with the release certificate SHA-256 ce1b7c62… (full cert fingerprint held with the key in secure custody; key material is NOT in this handoff and must never enter the repo). All three include the FCM notification dedup patch (notify(tag,0) + setOnlyAlertOnce).

Source parity, verified by empty git diffs: Android source trees (android/, android-management/, android-support/, mobile-android/) are byte-identical between c8734df, production main fa27d0e, and the latest line 57d225d / 7ece794. The candidates also pass every static APK assertion in tests/android-package.test.mjs and tests/pushtorq-android.test.mjs (dex contents, origins, no bundled keys).

Signing-identity constraint: package ids use the fresh .freshtest identity. Updates to these installs must be signed with the SAME certificate (sha256 ce1b7c62…); any other key makes Android reject the update. Do not re-sign with or migrate to a different key without an explicit owner decision.

## 2. Release-consistency check status (expected to fail until republication)
tests/android-package.test.mjs + tests/pushtorq-android.test.mjs currently fail 3/6 (gymeg-management, gymeg-members, support). Root cause, verified: public/downloads/*.json record source hashes matching commit c14add6 (2026-11-17 baseline); the published APKs predate the Nov 21 changes and the Nov 23 gold chain. Metadata and test files are unchanged since fa27d0e , no one edited expected hashes, and nobody should: the only valid fix is an atomic republication (new APK files + updated metadata json together), which is a gated release step, not yet authorized.
Prepared input for that step: release-consistency-prep/{management,members,support}-android.draft.json , review-ready draft metadata (freshtest package ids, candidate bytes + sha256, current-source hashes). Labeled DRAFT; not applied anywhere.

## 3. Windows desktop status
Published artifact (public, gymeg-downloads release windows-1.1.16, 2026-11-07): GymEG-Windows-x64-1.1.16.exe, 73,023,210 bytes, SHA-256 2c3c4349824d800dda8a26a3636c63217ea6a4ef21687a8f9acb1fc8cc05ae11, UNSIGNED (stated in its own release body). PE ProductVersion binds it to commit 885f5f48; at that commit the desktop-status bridge literal reports 1.1.15 while the app is 1.1.16 (stale bridge version compiled into the published binary; device runtime untested). A second, different windows-1.1.16 asset exists in the gymeg repo's own releases (73,001,580 bytes, sha 491d4162…, commit 9ff41337) , treat it as superseded/confusing; the website serves only gymeg-downloads.
Corrected source: archive sha256 0d2b06bf8a60021c2c53e48991316b41c7fa24ffc5c48c7bcc1bf06d63fc4c37 = commit a3c050f334e34d0174e45df7b614c9b159cd56bf / tree 280ed8d4…, includes the bridge fix (reports 1.1.16). Private compile-verified candidates (Linux cross-build, dotnet 10.0.404, -p:EnableWindowsTargeting=true; cannot run or sign here):
- baseline fa27d0e: 73,003,077 bytes, sha256 56005d4ef9e05fe3826de31fdd243e1dc4457ec7bdd68eb388de5a438b5011cc
- corrected a3c050f: 73,002,481 bytes, sha256 7fdcc5247341888b5ae4075731b0277133ec82e981e0317f7dd8d9351459ec06 (PE ProductVersion plain 1.1.16; source binding via the verified archive hash)
Recipe: dotnet restore windows/GymOS.Windows.csproj -r win-x64 -p:EnableWindowsTargeting=true && dotnet publish -c Release -r win-x64 --self-contained true -p:EnableCompressionInSingleFile=true -p:EnableWindowsTargeting=true --no-restore.
CI: the existing windows-release.yml workflow BUILDS AND PUBLISHES a public release on manual dispatch (not build-only). GitHub Actions standard runners are free for these public repos. Known constraints: the workflow publishes to the repo it runs in, while the site serves gymeg-downloads only; the publisher script refuses same-version replacement, so the next release needs a version bump; the bump (csproj + app/lib/windows-release.ts + tests/windows-release.test.mjs) must land atomically with the release or the public download link 404s. Signing path windows/Sign-GYMEG.ps1 is ready but needs a code-signing certificate purchase (owner decision). Runtime acceptance (install/Google login/notifications/devices/backup/speech/bilingual UI) needs a real Windows machine.

## 4. Support sender
Current held implementation and remaining scope are in ../CONTINUE.md and scripts/support-sender-held/README.md. No real send or device receipt is established.

## 5. What remains gated (native side)
1. Atomic Android republication: place the three candidates + apply the draft metadata together; then the consistency suite should pass. Needs release authorization.
2. Real Android device acceptance of the candidates (install/update, Google login, push foreground/background/click, bilingual journeys). Not started; no device claim exists.
3. Windows: version-bump + atomic publish decision, signing-certificate decision (cost), real Windows device acceptance.
4. Support sender: isolated host + credential custody, then approved two-event send proof to owner devices.
