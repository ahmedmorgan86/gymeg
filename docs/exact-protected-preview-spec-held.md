# Protected Rehearsal preview contract, HELD

This is the single current contract. It replaces overlapping preview assumptions in earlier held documents. No push, deployment, environment change, selected version initialization or production activation is authorized by this document.

## Exact target and source

Original gymeg project only. Base served source is fa27d0e7923e524cdea33e97a03de571b53137d6. The preview candidate adds exact owner containment and a preview-only request/authentication fence. Dedicated reviewed non-main branch only. No production aliases, project changes, production variables, new host/project, paid upgrade or public/bypass links.

Selected tenant: 8fe27fc0-d42f-4bf3-be47-5ca734c2ce74.
Selected storage owner: tenant:8fe27fc0-d42f-4bf3-be47-5ca734c2ce74.
Selected authenticated actor: b8a3d991-04a7-4b11-a680-6f60cfbc5250.
Morgan and every other owner are excluded from derived mutations.

## Fence

GYMOS_REHEARSAL_PREVIEW=1 requires VERCEL_ENV=preview, otherwise every matched request is refused. Universal Next matcher /:path* covers static-looking, internal data and image paths. Only GET/HEAD root, sign-in, /_next/static/, /icons/, /fonts/, favicon.ico, manifest.json and the three workspace reads are admitted. The reads are /api/workspace, /api/workspace/member-candidates and /api/workspace/member-detail. Only POST /api/session is admitted as a mutation. No DELETE sign-out, server-action POST, OAuth/recovery/cron, platform/member/team/commercial/source mutation is admitted. Encoded or ambiguous paths reaching the fence are refused. Next can normalize or redirect a path before the fence, and its normalized destination is fenced too.

Request tenant cookie is pinned. Verified user must be the selected actor. Commercial mode is required; support tokens are ignored; resolved storage owner must match exactly. Missing state fails rather than bootstrapping source data. Server summary readers additionally enforce the exact owner allowlist. Switch OFF retains ordinary application behavior, except that the matcher now also covers formerly excluded assets and those requests can run ordinary refresh logic. This candidate must not be promoted to production as an incidental next step.

Password login validates the returned provider actor before persisting any new app session cookie. A wrong-actor successful provider authentication is refused by the app, without a new app cookie. Supabase may already have created its provider-side session/token and auth logs before returning the actor. This effect cannot be erased by the app refusal and is inside the proposed ordinary login scope, not a claim of no provider effect.

## Exact branch inputs

The accompanying protected-preview-overrides-held.json is the full proposed literal override map, generated from source-referenced GYMOS and NEXT_PUBLIC_GYMOS names and explicit sender/admin secrets. It names each key and value individually. No placeholder such as 'all other flags' or 'any discovered secrets' is an execution instruction.

Additional branch-only connection input DATABASE_URL is proposed to reuse the existing vault item Supabase gymeg runtime role. Fresh TLS read-only identity verified it reaches original project aynycpumwcopbnkbkqhr as gymos_app in postgres, LOGIN true and superuser/BYPASSRLS/CREATEROLE/CREATEDB false. Do not substitute the migration credential, rotate passwords or create roles/grants. This does not establish equality with the opaque existing Vercel Preview secret, which is not to be revealed or reused by assumption.

Retain NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY only after verifying original project binding. They are public auth inputs, not database administrator credentials. No service-role key is needed or referenced by this candidate. Branch-only overrides must not alter inherited/shared values. VERCEL_ENV is platform-supplied, not a user override. NODE_ENV remains production in the hosted artifact.

The literal JSON disables Firebase/mobile service accounts, Google secret, PIN/encryption/sender/VAPID/WhatsApp/cron/realtime secrets and all non-selected feature flags. Realtime URL is routed to a reserved non-resolving target. Firebase persistence is independently excluded by postgres backend; Google and sender routes are independently denied. Public Firebase/VAPID identifiers are not credentials and do not enable those denied routes.

Source-derived names are exhaustive for the reviewed candidate, not proof of the currently saved environment. Exact effective values and branch precedence remain an admission check during authorized setup, before build/deploy. Branch-specific precedence is documented at https://vercel.com/docs/environment-variables and its branch selector was inspected. Check selected branch/Preview target for every override, no Production target. Inventory saved variable names for alternate credential-bearing names and inspect their actual source use without disclosing values. A mismatch or unreviewed alternate credential name stops setup; it does not authorize more overrides. Inspect effective build/runtime flags and DB identity without logging secrets. The current deployment has not been created, so effective deployment inputs cannot yet be claimed verified.

## Effects requiring the grouped grant

1. Dedicated branch creation/push and original-project protected Preview deployment, with exact branch-only inputs and existing restricted runtime credential reuse.
2. Exact held selected derived version/materialization entrypoint and hashed package, once only, before enabling readers. Existing approved readiness is not permission for this initialization. Enforce all-source and excluded-derived parity, bounded writer pause and exact timeouts. Uncertain COMMIT means read-only reconciliation, never an automatic retry/cleanup/reversal.
3. Ordinary password login, provider token/session creation and provider audit/security logs; session-refresh token rotation on allowed paths with existing cookies; browser session and pinned club cookies. Wrong-actor provider authentication still has the provider effects described above.
4. Shared gymos.auth_rate_limits INSERT/UPDATE for the attempted email/IP and IP buckets, including wrong-account attempts. These are non-tenant operational rows, so the preview is not strictly read-only. Hosted NODE_ENV=production uses the shared store. Local session proof uses a per-process limiter, not proof of hosted shared SQL limiter behavior.
5. Selected summary reads can refresh selected gym_member_summaries and clear selected dirty rows within their bounded routines. Held selected initialization also creates/updates the selected version/materialization state. No unselected derived or original-source mutation.
6. Hosting build/deployment/access logs and ordinary read transactions/locks. /api/workspace GET, including HEAD if mapped to GET, loads packet/revision/photos but has no intended SQL source-write path under the postgres backend. Commercial context reads membership/tenant/license and transaction-local actor/tenant settings. Selected readSpace refuses missing state. No scheduled sender is allowed to run through this fence; no FCM, WhatsApp, SMS, Google OAuth or realtime send is part of acceptance.
7. Controlled refusal tests and eventual removal/disable of the preview only if explicitly included. Never click a live source action just to see if it fails without that test scope. No automatic derived reversal or credential cleanup beyond the approved recipe.

## Evidence and remaining acceptance

Local real HTTP synthetic GoTrue, real auth adapter/cookie codec/session route, verified user/commercial context, actual candidate/detail routes and migrated PGlite transport proof: 10 tests PASS, including source/excluded parity and wrong-actor login without a new cookie. Next request storage and pg transport are test doubles; hosted provider, TLS and RLS are not established by this fixture.

Actual installed Next16.4.6 local HTTP development server and production next start both passed 16 route-boundary cases: source POST/PUT; root/sign-in server actions; cron HEAD/RSC; static-extension API; literal and encoded dot normalization; encoded segment/slash; internal _next/data and image proxy; favicon suffix; spoofed middleware-subrequest header. Fifteen return403; duplicate separators redirect308 to the refused normalized destination. Full flagged production build and separate TypeScript check PASS after limiting build heap. Earlier killed137 build is superseded by the successful full build, not hidden.

No finite path test proves all future framework behavior. Final hosted protected-preview acceptance must verify unauthenticated Vercel Authentication refusal, authenticated effective app/DB identity and RLS, clean-cache selected English/Arabic list/detail parity against the full packet, screenshots, exact allowed/denied request tests, all-source and excluded-derived parity, no outbound sends and no changed production routing. Only owner with existing Vercel access reviews. No bypass/shareable link. Stop on drift.

Production requires a separate later decision after owner preview acceptance. Environment changes do not disable existing artifacts. Do not promise immediate env-toggle recovery. Current Hobby instant rollback is restricted to the immediately previous production artifact, retains that artifact's environment and restores its cron definitions; it is not preview authority or permission to change production.
