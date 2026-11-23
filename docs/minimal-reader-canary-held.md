# Held minimal member-reader canary

No deployment, flag change or derived initialization is authorized by this preparation.

## Exact application delta

Base: fa27d0e7923e524cdea33e97a03de571b53137d6, current served production source checked November 23, 2026 at 22:32 Cairo.

Runtime changes only:
- app/lib/demand-owner-scope.ts: exact authenticated storage-owner allowlist.
- app/api/workspace/member-candidates/route.ts: reject excluded owners before database work.
- app/api/workspace/member-detail/route.ts: same boundary.

The existing served client already has both readers and exact legacy fallback. This candidate deliberately excludes the other 60-plus development commits, Support changes, native changes, migrations and unrelated UI changes. It does not include the held materialization helper, which remains an independently pinned operator operation.

## Proposed production environment delta, not applied

Set only:
- GYMOS_DEMAND_ALLOWED_OWNERS=tenant:8fe27fc0-d42f-4bf3-be47-5ca734c2ce74
- GYMOS_MEMBER_SUMMARIES=1
- NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES=1

Keep every other demand reader flag, GYMOS_HOT_OPS, GYMOS_PACKET_OMIT_VISITS, NEXT_PUBLIC_GYMOS_PACKET_OMIT and NEXT_PUBLIC_GYMOS_LAZY_STRICT unset or 0. Do not change independent Support, notification, financial or portal flags, credentials or settings. The environment-name inventory showed no current demand flags. Values and targets must be rechecked immediately before an authorized change. Public flags require a new build.

The public summary flag reaches every tenant's browser. The server allowlist admits only the selected Rehearsal storage owner. Excluded owners receive 404 from these two routes and continue using the complete legacy packet. There is no full-load reduction claim. No source write is needed to initialize a version.

## Derived prerequisite, separately held

The existing reviewed 3217daa operator package initializes only an absent selected owner version and refreshes selected dirty summaries. Its independent root is 7de381600fb9d00a1667fd403838619c4c9830811176a47eee38b0645019ccc6. Exact current identity/readiness admission, 20s transaction, 2s lock, 15s statement, all-owner source parity and excluded-owner derived parity remain required. A fresh source write may already have supplied the version, so admission must preserve it. Rehearsal readiness approval does not authorize this additional effect.

## Evidence

Both the ordinary production build and a build with exactly the proposed three enabled values, strict=0 and omission=0 passed on this minimal source. Actual Chrome over the real candidate/detail routes with a disposable database passed selected materialization, excluded distinct-owner dirty/stored parity, list, metrics, detail and legacy attendance equality. This proves fixture behavior, not authenticated production acceptance. The fixture screenshots lack global CSS and contain synthetic image/overlap artifacts. They are not production visual acceptance.

## Proposed acceptance and rollback, not executed

1. Independently review the exact candidate commit and hosted materialization root. Obtain one scoped decision covering selected derived initialization, this application deployment, its exact three environment values, read-only authenticated Rehearsal acceptance and rollback authority. Morgan source and derived mutations remain excluded.
2. Immediately before any effect, re-read original user authority, current production source/deployment/environment, selected identity/version/readiness and excluded-owner baseline. Stop on drift. Do not push the broad development branch. A production publication has user-visible effects even for excluded users and needs explicit authority.
3. Execute the unchanged reviewed selected derived operation once while readers remain OFF. Stop on failure; uncertain COMMIT is reconciled read-only, never retried automatically.
4. Build/deploy only the reviewed minimal application source with the exact environment delta. No new host, project or tunnel. No sender, FCM, account or APK metadata changes.
5. Using the existing authenticated selected Rehearsal account, read list and detail in Arabic and English, compare to the full legacy packet, inspect actual pixels, and perform no attendance, payment, edit or notification action. Verify current sources and excluded derived parity read-only. A real Morgan login or mutation is not necessary and not authorized by this plan.
6. On new route errors, result differences or containment failure, stop acceptance and use the separately approved rollback. Disable the server reader immediately and restore the previous production deployment and original environment state; public flag removal requires rebuilding or promoting the previous artifact. Do not reverse shared schema, remove readiness, reset sequences or delete summaries. Previously minted version gaps are harmless but remain recorded.

Current production rollback reference, observed in the dashboard: dpl_7sGRbfW6cXopGWfuvkwviZKnDXjk, served source fa27d0e, https://vercel.com/ahmedmorgan86s-projects/gymeg/7sGRbfW6cXopGWfuvkwviZKnDXjk. Its presence is verified, but rollback action and permissions have not been rehearsed or exercised. Do not promise automatic rollback until that procedure and authority are settled.

## Still outside this canary

Operations current-presence replacement, full report/WhatsApp/device fallback closure, packet omission, native/device/iPhone/Google acceptance, real notification delivery, and the broader release remain separate unfinished work. OMIT_READERS_COMPLETE remains false.
