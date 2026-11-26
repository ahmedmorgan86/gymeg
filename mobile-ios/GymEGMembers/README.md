# GymEG Members — Native iOS App (SwiftUI + WKWebView)

Native iOS shell for GymEG Members (`https://gymeg.vercel.app/member`), ready for Xcode & App Store Connect.

## Features
- **WKWebView** locked to `https://gymeg.vercel.app` (HTTPS-only, opens external Paymob/Fawry/InstaPay checkout links in Safari).
- **ASWebAuthenticationSession** for native Google OAuth sign-in (`gymeg-member://`).
- **Universal Links** (`applinks:gymeg.vercel.app`) & **APNs** push notifications (`aps-environment`).
- **Offline fallback** with Arabic retry screen and pull-to-refresh.

## Build & App Store Submission (requires macOS + Xcode)
1. Open **Xcode** on macOS → **File → New → Project → iOS App** (`GymEGMembers`, Bundle ID: `com.gymeg.members`, SwiftUI).
2. Replace/add `GymEGMembersApp.swift`, `MemberWebView.swift`, `Info.plist`, and `GymEGMembers.entitlements` from this folder.
3. Select your Apple Developer Team → **Product → Archive** → **Distribute App → App Store Connect**.
