# Exact protected Rehearsal preview specification, held

## Source boundary

Based directly on current served fa27d0e. The earlier three-runtime-file minimal canary gains a PREVIEW-ONLY fail-closed safety fence. This is a changed candidate that needs its own review. Never deploy this candidate to production with GYMOS_REHEARSAL_PREVIEW=1: all dynamic requests fail closed outside VERCEL_ENV=preview. Switch OFF preserves existing production behavior.

With the switch ON:
- Only password-login POST /api/session is admitted. Existing authentication rate limiting can write shared limiter rows, and authentication can rotate refresh tokens. No global sign-out is admitted.
- Only GET/HEAD /, /sign-in, static assets, /api/workspace, /api/workspace/member-candidates and /api/workspace/member-detail are admitted. All other APIs, OAuth/recovery, cron, team/commercial mutation, platform/member pages and ordinary source writes are rejected before auth-refresh work.
- The authenticated principal must equal the independently verified Rehearsal creator UUID b8a3d991-04a7-4b11-a680-6f60cfbc5250. This is an added restriction, never an authentication bypass.
- The selected-club cookie is pinned to 8fe27fc0-d42f-4bf3-be47-5ca734c2ce74. Commercial authenticated context must resolve the exact Rehearsal storage owner. Support tokens are not used. Commercial mode is required. A missing state refuses rather than bootstrapping source rows.
- Server summary readers additionally use the exact storage-owner allowlist. Original-source rows remain untouched; selected summary refresh is an intended derived effect. Readiness/version/materialization permission remains required separately.

## Original-project deployment and access

Use the existing gymeg project only and a dedicated reviewed non-main Git branch or explicitly targeted preview CLI deployment. No production alias, production env or production branch change. No new project, public host, paid upgrade, bypass secret or shareable access link. Current Vercel Authentication Standard Protection remains enabled. Only the owner with existing Vercel access is the preview reviewer. Verify deployment-specific unauthenticated requests are blocked before authenticated acceptance. Authentication protection cannot be assumed merely because a setting exists.

## Proposed branch-specific overrides, not applied

Values that must be explicit for ONLY the reviewed preview branch:
- GYMOS_REHEARSAL_PREVIEW=1
- GYMOS_AUTH_BACKEND=supabase
- GYMOS_DATA_BACKEND=postgres
- GYMOS_COMMERCIAL=1
- GYMOS_DEMAND_ALLOWED_OWNERS=tenant:8fe27fc0-d42f-4bf3-be47-5ca734c2ce74
- GYMOS_MEMBER_SUMMARIES=1
- NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES=1
- GYMOS_PACKET_OMIT_VISITS=0
- NEXT_PUBLIC_GYMOS_PACKET_OMIT=0
- NEXT_PUBLIC_GYMOS_LAZY_STRICT=0
- All other demand/hot/private-credit/member-portal flags OFF.

Inherited sender/admin secrets must be replaced for THIS BRANCH with the literal non-secret disabled marker preview-disabled, not copied into new settings: GYMEG_MOBILE_NOTIFICATIONS_SERVICE_ACCOUNT, GYMEG_FIREBASE_SERVICE_ACCOUNT, GYMEG_GOOGLE_CLIENT_SECRET, GYMEG_MEMBER_PIN_KEY and any discovered VAPID private key, sender/cron/bypass tokens. Override both Firebase service-account variables, because FCM has fallback between them. Google login is blocked at the route fence and is not part of acceptance. Do not remove shared project variables. Verify effective deployment inputs do not retain real secrets under alternate keys. If branch-scoped override mechanics cannot be confirmed, stop before deploying.

Retain existing Supabase publishable URL/key only after verifying they name the original project (exact ref aynycpumwcopbnkbkqhr), and the existing preview DATABASE_URL only after inspecting host/database/role with the secret value kept out of reports and verifying its actual database identity read-only. The database credential remains server-only. No new role, grant, password or database project is implied. Do not use an administrator credential if existing application identity suffices. Effective DB identity and existing per-owner RLS/grants are still open checks, not completed proof.

## Execution and acceptance limits

No approval is currently present for branch push, env overrides, preview creation, selected version initialization or preview removal. A combined request should state those specific effects, ordinary login/limiter/token effects, selected-only derived writes, credential scope, no-Morgan/source effects, no notifications, no production promotion and no cost. One reviewed selected materialization execution comes before activating reader flags, with uncertain COMMIT reconciliation read-only and no automatic retry/cleanup.

After approved protected preview creation: verify protection from a clean unauthenticated request, effective app/database identity, selected English/Arabic list/detail against the complete legacy packet, blocked source mutation and sender/OAuth endpoints, and all-source/excluded-derived parity. Inspect actual screenshots. Never click an action merely to see whether it fails unless that exact controlled refusal test is authorized. Do not reuse production browser caches as proof. Stop on drift or unsupported flag/fallback behavior. Production requires separate review and permission after owner preview acceptance.

## Current evidence and limits

Nine pure/proxy regression tests passed, including fence-before-refresh, exact selected principal/owner, cookie pinning and unchanged OFF behavior. Final flagged build passed after the missing-state/noindex additions. Authenticated local end-to-end fence proof remains necessary. Source review is not production acceptance. Current inherited Preview DB target has not been opened or verified in this step. This document is a proposed safety specification, not a completed deployment recipe or user authorization.


## Runtime provenance resolved at 22:56 Cairo

A distinct existing vault login named Supabase gymeg runtime role authenticated over verified TLS to original project aynycpumwcopbnkbkqhr as gymos_app. A BEGIN READ ONLY identity query confirmed current_database=postgres, LOGIN true, superuser/BYPASSRLS/CREATEROLE/CREATEDB false. No source rows queried or effects performed; temporary export removed. This provides a viable explicit branch-only DATABASE_URL reuse proposal under new approval. It does not establish the opaque saved Vercel Preview DATABASE_URL has the same value, and must not be described that way. No migration credential substitution, rotation or new grants.

Local session-boundary integration passed actual password-session route, verified-user/selected-actor boundary and actual proxy refusal for workspace/commercial writes, Google/cron GET and global sign-out. Supabase auth provider and limiter were synthetic stubs, so this is NOT full cookie/TLS/provider/database end-to-end acceptance. Remaining local test should run a synthetic provider with real session cookies plus real local commercial context, selected owner and database derived behavior. No live preview permission follows from this test.
