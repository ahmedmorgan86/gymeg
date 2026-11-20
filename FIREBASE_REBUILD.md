# Firebase rebuild status

Branch: `firebase-rebuild`. Do not deploy or promote this branch while the remaining SQL paths below are present.

## Firebase data model

- Firebase Authentication verifies email/password and issues a signed, revocation-checked server session cookie. New accounts must verify email before a session is accepted.
- Member phone and PIN access uses Firestore `member_code_access`, `member_code_sessions`, and `member_code_attempts`. PIN verification and phone lookup use keyed digests; display PINs use authenticated encryption. `GYMEG_MEMBER_PIN_KEY` must be a stable 32-byte base64 secret. It is configured only for this branch's Vercel preview so far.
- `GYMEG_FIREBASE_SERVICE_ACCOUNT` must belong to `GYMEG_FIREBASE_PROJECT_ID` (GymEG). Push delivery is a separate Firebase project; use `GYMEG_MOBILE_NOTIFICATIONS_SERVICE_ACCOUNT` and `GYMEG_MOBILE_NOTIFICATIONS_PROJECT_ID` for it. The server refuses a project mismatch. The current Vercel service account's project identity has not been confirmed.
- Firestore `gym_states`, `gym_entities`, `gym_photos`, `gym_recovery`, `gym_activity_archive`, `member_faces`, `membership_cards`, `card_reservations`, `card_number_counters`, and `workspace_outbox` hold workspace state and activity. Existing documents are read in place; there is no Supabase import.
- Browser push and native FCM subscriptions are stored in Firestore with encrypted tokens and tenant-scoped recipient checks. The change feed requests a fresh snapshot when a Firebase revision advances; incremental Firestore events are not implemented yet.
- WhatsApp connections, templates, pending jobs, opt-outs, and webhook receipts use Firestore when Firebase is configured. Provider tokens require a separate stable 32-byte base64 `GYMEG_WHATSAPP_TOKEN_KEY`. A job with uncertain delivery is never retried automatically. The configured Vercel cron runs daily; manual Run is available.
- `tenants`, `tenant_memberships`, `tenant_licenses`, `commercial_plans`, `activation_requests`, `open_orders`, `trial_claims`, `transfer_refs`, `platform_settings`, `platform_admins`, and `commercial_audit` hold commercial state.
- `gym_access`, `gym_invites`, and `gym_access_events` hold staff access and audit. Commercial staff membership is also written to `tenant_memberships` atomically.
- `gym_backup_transfers/{id}/chunks/{part}` holds temporary backup uploads/downloads. Expired transfers are denied, but automated cleanup is still needed.
- Firestore rules deny direct client access. Server routes use Firebase Admin and must verify session, club, role, and branch. Index definitions are in `firestore.indexes.json`.

## Required before a release

1. Replace every remaining SQL caller and remove `pg`, Drizzle, PGlite, SQL migrations, and the Postgres adapter after replacement. The new WhatsApp path still needs emulator and provider integration testing.
2. Add Firestore emulator integration tests for club creation, invitation claims, ownership, license changes, backup transfer, tenant isolation, Firestore rules, and revoked sessions. Run the full test and build gates.
3. Verify the existing Firestore workspace documents and take a backup before deploying rules or indexes. Do not delete existing data or Vercel variables.
4. Register the intended platform owner in Firebase Auth, verify the email, then bootstrap `platform_admins/{uid}` from a trusted administrative machine using `scripts/firebase-bootstrap-admin.mjs`. The old Supabase UUID is not a Firebase identity and is never granted access automatically.
5. Deploy the rules and indexes, test the preview branch end to end, then plan the production cutover. `GYMEG Mobile Notifications` is a separate push delivery project and is outside this data rebuild.

The local unit suite covers legacy behavior as well as some shared helpers; it does not prove the new Firebase flows work against a live database. A successful typecheck or build is not a deployment approval.
