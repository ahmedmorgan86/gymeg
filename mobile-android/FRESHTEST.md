# Freshtest flavor (rehearsal target)

Reproducible mapping for the fresh-Supabase rehearsal build. Everything here
is committed source: `gradle :members:assembleFreshtestDebug` and
`gradle :manager:assembleFreshtestDebug` rebuild both artifacts byte-for-byte
from this tree (modulo timestamps). No uncommitted patches are involved.

| | Members | Management |
|---|---|---|
| Package | com.pushtorq.members.freshtest | com.pushtorq.management.freshtest |
| Version | 1.1.8 (10), debug-signed | 1.1.9 (11), debug-signed |
| Origin (BuildConfig.WEB_HOST) | gymeg-supabase.vercel.app | gymeg-supabase.vercel.app |
| Firebase project | gymeg-mobile-notifications | gymeg-mobile-notifications |
| Firebase app id | 1:744394281001:android:2dbd9d9f5a883ef04b8c38 | 1:744394281001:android:73a8a567658818404b8c38 |
| google-services.json | src/freshtest/google-services.json | src/freshtest/google-services.json |
| App label | GymEG أعضاء (تجريبي) | GymEG إدارة (تجريبي) |
| Signing cert SHA-256 (debug, freshtest scope only) | D0:06:AC:76:C5:5D:DB:10:F4:32:18:32:A1:42:AE:32:09:F6:43:74:78:1F:BB:5E:07:E2:8E:61:24:E1:52:E8 | same |
| APK sha256 (this commit's build) | 8690939ec0be28ae05409ae7486c3b45fbc4a7ae61293eeb59db8b1fd5853d09 | b10a879e94104cee4ea8815f18c36b677301083a8e95b861d689ba452aa25b3d |

The debug certificate above is a fresh-test identity only. It is NOT a
production package identity and must never be registered as one; production
App Link entries await the real release signing certificate.

Production flavor (default committed target): package without suffix, origin
gymeg.vercel.app, main google-services.json, release signing via
GYMEG_KEYSTORE env vars (not present in CI/sandbox).

App Link verification: public/.well-known/assetlinks.json lists the freshtest
packages with the debug fingerprint above; production entries are added when
the release certificate exists. The file is served from the origin the
corresponding flavor points at.
