# GymEG Android release — 2026-11-04

Production website commit: `3c967c4da4b1e3057dae4b0c4f5d041af494db36`.

| App | Version | Version code | Production download |
|---|---:|---:|---|
| Club management | 1.1.9 | 11 | https://gymeg.vercel.app/downloads/GymEG-Manager-Android-1.1.9.apk |
| Members | 1.1.8 | 10 | https://gymeg.vercel.app/downloads/GymEG-Members-Android-1.1.8.apk |
| Support | 1.0.7 | 8 | https://gymeg.vercel.app/downloads/GymEG-Support-Android-1.0.7.apk |

All three release APKs were built with Gradle 8.13, signed with the existing Android release key, and checked for signature validity and ZIP alignment. The certificate SHA-256 is `413b3db51468b0ed14765ae410b2d7c5a6f7fc3121b67aaae82d3e378ccdf4c2`. JSON sidecars contain SHA-256, size, URL and source hashes. The installed APKs load their role-specific web interface from `https://gymeg.vercel.app` and require internet access.

No physical-device install, push delivery, camera or hardware acceptance test was performed in this release. The web interface and member-card redesign are deployed separately on the production site.
