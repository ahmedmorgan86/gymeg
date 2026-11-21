# Freshtest flavor (rehearsal target)

Reproducible mapping for the fresh-Supabase rehearsal build. Everything here
is committed source: `gradle :members:assembleFreshtestDebug`,
`gradle :manager:assembleFreshtestDebug` and
`gradle :support:assembleFreshtestDebug` (module dir android-support) rebuild all three artifacts from this tree with no uncommitted
patches. Byte-for-byte identity is NOT claimed: the toolchain (JDK 17,
Gradle 8.13, Android SDK platform/build-tools 36.0.0) and the debug signing
key are environment properties, not pinned in this repo, so hashes identify
this build's artifacts rather than a reproducible-build guarantee.

| | Members | Management | Support |
|---|---|---|---|
| Package | com.pushtorq.members.freshtest | com.pushtorq.management.freshtest | com.gymos.support.freshtest |
| Version | 1.1.8 (10), debug-signed | 1.1.9 (11), debug-signed | 1.0.9 (10), debug-signed |
| Origin (BuildConfig.WEB_HOST) | gymeg-supabase.vercel.app | gymeg-supabase.vercel.app | gymeg-supabase.vercel.app (HOST BuildConfig field in MainActivity/NotificationBridge) |
| Firebase project | gymeg-mobile-notifications | gymeg-mobile-notifications | gymeg-mobile-notifications |
| Firebase app id | 1:744394281001:android:2dbd9d9f5a883ef04b8c38 | 1:744394281001:android:73a8a567658818404b8c38 | 1:744394281001:android:baeadadf5f37bde14b8c38 |
| google-services.json | src/freshtest/google-services.json | src/freshtest/google-services.json | android-support/src/freshtest/google-services.json (official Firebase client config supplied after registration) |
| App label | GymEG أعضاء (تجريبي) | GymEG إدارة (تجريبي) | GymEG دعم (تجريبي) |
| Signing cert SHA-256 (debug, freshtest scope only) | D0:06:AC:76:C5:5D:DB:10:F4:32:18:32:A1:42:AE:32:09:F6:43:74:78:1F:BB:5E:07:E2:8E:61:24:E1:52:E8 | same | same |
| APK sha256 (this commit's build) | 42379530e365e2a2991cbbea0c38bf4a5dbb7c15e7f817f2e281a71e0f543c64 | 48552efe9c6988fabea2e7bd6598e4599a3dbcfe3302c23da9f61af72cc533b6 | ac0fe9310250b0b6f11669797bc2cb6c281d06c51e59965916b558e82495a12d |

The debug certificate above is a fresh-test identity only. It is NOT a
production package identity and must never be registered as one; production
App Link entries await the real release signing certificate.

Production flavor (default committed target): package without suffix, origin
gymeg.vercel.app, main google-services.json, release signing via
GYMEG_KEYSTORE env vars (not present in CI/sandbox).

App Link verification: public/.well-known/assetlinks.json lists all three
freshtest packages (members, management, support) with the debug fingerprint
above; production entries are added when the release certificate exists. The
file is served from the origin the corresponding flavor points at. Each app
registers only its own handoff return path (/auth/mobile/callback/members,
/management, /support) with android:autoVerify.

Support freshtest registration was verified in the Firebase console on 2026-11-21.
The official client config matches project number 744394281001 and the app ID
above. The rebuilt APK embeds that exact app ID. This is build/config verification,
not a claim of support-device login, registration or push delivery. Production
flavor version and signing identity are unchanged.
