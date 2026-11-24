# GymEG: complete the remaining release work

You are continuing an existing Arabic/English GymEG project. Do not restart it or replace it with a demo. Work from the branch `codex/gymawy-commercial-gaps` in https://github.com/ahmedmorgan86/gymeg, not stale main. Read this file and docs/handoff/README.md before making changes. This handoff is source-only, not production-release approval.

## Goal and working rules

Finish the full existing product scope: web, Manager/Members/Support Android apps, Windows desktop, bilingual UI, Google login, notifications, attendance/offline, members/subscriptions/renewals/cancellation/finance, team permissions, backups/restore, photos, devices, audio/speech and public downloads. Do not silently drop features or treat passing isolated tests as acceptance. Prioritize a usable complete artifact over endlessly adding synthetic permutations. Report concrete completed outcomes and exact blockers, not percentages or promises.

No new production deployment, flag activation, production schema/role change, customer-data mutation/deletion, spending, signing-key replacement or external notification send is authorized by this handoff. The latest request authorized uploading product work to GitHub and preparing this continuation. Recover exact prior approvals with the owner before relying on them for a new effect. Existing narrowly scoped schema/readiness actions are not blanket rollout approval. Never replay a migration because a filename exists.

Do not put secrets in chat/git/files. Use a suitable secure credential mechanism. Do not alter existing passwords, Google callbacks, SMTP, Auth providers or project settings as an incidental fix. Do not use a broad GitHub credential in tenant runtime. Preserve the5second member-chat refresh. Do not delete the existing test member/message in the excluded real club without permission. No real customer overwrite or restore-overwrite. No production automatic WhatsApp sending merely because local tests pass.

## What is included and what is deliberately excluded

This branch consolidates completed product source/tests/docs plus clearly held/incomplete candidates. It is a clean snapshot over an existing branch because intermediate private operational history contained target bindings. Full private history was retained outside this public branch. Application behavior comes from the integrated57d225d source line; later local work through914f14b was tests/docs and held sender source, not app activation. UI fixes0001a4b and454a341 and Windows bridge fix3656897 are included. Commit identifiers above identify historical provenance and may not all be reachable in this sanitized branch.

`docs/handoff/preview-signin/local-only.patch` preserves the separate preview-only sign-in UX, plus its test helpers. It is not applied to current application source or deployed. Review against current code before applying; its original base was16e5fe4. Qualified failure copy must not imply a recovery link was delivered when it was not.

`docs/handoff/native/` contains native state/provenance and three UNPUBLISHED metadata drafts. New private APK/EXE candidate binaries were NOT added to the public repo. Do not call this a binary release. Android candidates were privately retained by the owner; request those files only if needed for device acceptance, not another rebuild. Windows candidates are compile-only and can be rebuilt with the documented recipe. Existing old public downloads remain unchanged.

Held operational scripts/docs have private project/owner/email bindings replaced with REVIEW_REQUIRED placeholders. Their historical hashes/pins are no longer valid execution authorization or reproducible hosted manifests. Reconstruct exact target bindings and regenerate/review pins from current authorized sources before execution. No private backup/customer payload is included. Some older documents are historical and contradict later scoped events; this file and actual code/evidence distinctions take precedence over blanket status wording, but do not establish live state.

## Verified evidence, with limits

- Integrated application local typecheck and full Next production build passed after57d225d. All42registered local integration suites ran in bounded groups without failures on that application line. Three external suites were not executed: live-server API, real-PostgreSQL commercial restore and support RLS prerequisites. Six DB-gated units are outside that result. No claim that the whole current release suite passes.
- Actual Workspace all-reader fixture covers owner EN/AR, manager branch-b EN/AR and reception branch-a EN/AR, loading/failure/Retry, full35row console/advanced history order and strict unknown behavior. Scoped evidence, not every feature/role/device combination.
- Actual local exit/delta/restore, synthetic owner-context reload, delayed candidate/quota/detail/history responses and48sequential exits to revision53 matched full-packet peers. Short/fixed-clock synthetic tests are not prolonged concurrent production load.
- Actual service-worker/IndexedDB local offline fixture queues one scan, reconnects and replays once; owner/actor/role mismatch refuses replay and retains queue, restore conflict pauses for review. Reload/manual-review limits remain.
- A separate actual Next production-chunk offline boot passed on an isolated synthetic page with full packet and intercepted APIs. It was NOT authenticated real assembled reduced-artifact acceptance and cannot be combined with the separate reduced fixture to claim that.
- Omission is deliberately hard blocked by `OMIT_READERS_COMPLETE=false` in app/packet-capable.ts. Do not flip it just because the flags exist.
- Scoped actual-role local PostgreSQL plans/financial/lifetime tests exist under docs/performance. They retain explicit caps, fallback, unsupported-layout and timing gaps. Local PostgreSQL is not hosted provider/load acceptance.
- Android source parity was independently verified between c8734df and integrated57d225d/7ece794 across all4Android trees. Gold candidates are signed/aligned/static-verified, never installed/run on physical devices. Published source hashes match olderc14add6, so release consistency legitimately fails3/6public-artifact checks. Do not edit expected hashes to hide that staleness.
- Windows source bridge now reports1.1.16 consistently. Private Linux crossbuild proves compile only, not Windows install/run/Google/push/signature/update. Existing published Windows artifacts are unsigned and have provenance/version/link caveats in native STATE.md.
- Support sender remains non-executable/held. Current isolated worker tests22unit and22disposable restricted-PG checks passed. Actual orchestration to local ledger uses fake transport only. No real FCM send or device receipt. The standalone worker entry refuses execution.

## Exact critical path

1. Freeze this exact source and existing private native candidates. Verify one complete locally built web artifact with authenticated synthetic owner/manager/reception, Arabic/English navigation and real offline/reconnect. Use real production Next routes/assets and restricted disposable PostgreSQL, with a local synthetic auth service if necessary. Do not replace app/page.tsx with a Workspace-only fixture and call that authenticated artifact acceptance. No customer account or remote schema needed. Preserve full packet/hardfalse until the actual omission gate is closed.
2. Complete the minimal Support sender for the original two events, owner devices only, fixed privacy-safe bilingual content and /platform target. Read scripts/support-sender-held/README.md and docs/support-sender-host-options-local.md. Finish isolated token resolver/decryption/bearer signing, bounded database acquisition/lifecycle and uncertain-COMMIT reconciliation, retry jitter/shared admission and credential/host boundary. Do not import the old all-admin prototype or tenant-facing sender keys.
3. Finish named server demand/lifetime/financial gaps and measure actual before/after reads and write cost, not just packet size. Keep unsupported cases honest. Full-owner allocation scan/cap limits and portal/auth/shared-pool lifetime remain real limitations, not optional cosmetic hardening.
4. Close full bilingual role/branch UI and real device journeys. Then freeze exact source/artifacts, rerun appropriate Node24 tests/typecheck/lint/build/dependency/security/signature checks, and present the exact deployment/publication/flag/schema effects still needing approval.
5. Only after explicit applicable approval: atomic app artifact+metadata publication, correct download links/QR, exact web deploy/flags and postdeploy live acceptance. Do not dispatch windows-release workflow as a build-only operation: it publishes.

## Support candidate details and remaining implementation

Two intended events: quote_requested and transfer_submitted for owner review. Current local fixed body is in business-worker.mjs. event/recipient/lease bounds, claim-generation fences, owner-only RLS, first-claim recipient snapshot, no expansion on reclaim, delayed retries and explicit possible duplicates are covered locally. At-least-once only: lease expiry while send in flight and crash-after-send-before-ledger remain duplicate windows.

Current version quarantine reuses invalid ledger rows keyed by user/token hash/ciphertext version, with no subscription DELETE privilege. It prevents future snapshots of the same invalid version and allows replacement ciphertext. It is not stable global token retirement: re-encryption changes version, history cleanup loses quarantine and lookup growth needs review. Avoid broad DELETE. Stable enrollment identity/retention can be designed locally without blocking the minimal safe sender on optional automatic cleanup.

Transport-held.mjs has injected fetch/token/bearer dependencies only. Bare404 never marks a token invalid; exact structured FCM UNREGISTERED does. Retry-After seconds/date and429minimum60s are persisted through worker and ledger. Timeout/network ambiguity is unknown, never proof that nothing sent. Review official current FCM retry policy before real use.

The local pre-send current-source-status suppression is PROPOSED, NOT an approved product rule. Leave optional suppression out of installed behavior unless original intent or owner decision settles it. Do not make the owner choose internal APIs. A source-only client-lifecycle draft is unfinished/untested and not wired; do not assume it solves connection acquisition or uncertain commit.

Operator aggregate distinguishes business admission, awaiting claim, pending/sending, transportAccepted, noRecipients and failed, with deviceReceipt always unverified. Restricted single-statement local inventory exists, not a live API/UI dashboard.

Host research is not account-ready acceptance. Existing public-repo scheduled GitHub standard runner is free per docs but minimum5minute schedule can be delayed/dropped. Dispatch needs repository-wide Actions-write, not one-workflow token, and does not guarantee immediate start. Existing-project Supabase Edge inherits project/database/admin secrets, so do not call it a clean sender-only boundary. Cloudflare per-Worker secrets/free tier is another unverified option with CPU/runtime/account gaps. Recheck actual resources and protections before proposing install; never spend or provision a new host without scope.

## Remaining full scope, do not lose these items

- Google login on website, all3Android apps and Windows, actual callback/origin/cookie behavior. Synthetic auth fixtures are not real Google acceptance.
- Android install/update, signing identity, foreground/background/click notifications, camera/barcodes/cards, member phone+PIN, Arabic/English UI. Keep original freshtest signing certificate for updates, no key replacement.
- Windows real install/run/update, Google, push, devices/hardware, backup/restore, speech/audio and bilingual UI. Desktop Chrome/Brave notification evidence is not native Windows proof. Code-signing purchase is a separate money decision, not required permission to spend now.
- iPhone Safari/mobile web and other browsers/devices, not just one desktop browser.
- Desktop calendar column wrap and public-page language/direction, remaining role/branch UI review and complete assembled workflows.
- Member subscriptions/renewal/cancel/freeze/quota, balances/payment allocations/refunds/finance/report correctness and branch privacy across owner/manager/reception/member contexts.
- Existing photo compression and safe small2branch demo dataset. Never delete/overwrite real data to seed it. Preserve excluded-club leftover test member/message until deletion approved.
- Automatic WhatsApp consent/revalidation, durable scanning, provider unknown-send outcomes, pool/concurrency/real SQL cost and actual authorized sending. Reading counts does not authorize outbound messages.
- Devices/attendance ingest and replay, hardware/camera/cards, member portal and private-credit large-owner limits, team permission/RLS and customer-data isolation.
- Exact current hosted schema compatibility and concurrent-request impact from an earlier aborted DDL attempt remain unresolved, even if later selected maintenance/readiness succeeded. Recheck source and current target under approved access; do not assert no impact solely because a transaction aborted.
- Recoverable backups: contained logical restore and payload parity are not whole managed-project disaster recovery, restored ownership/ACL/service/Auth/key/runtime equivalence. Reuse encrypted private proof without uploading customer data; no paid clone or restore-overwrite inferred.
- Read reduction: current hosted prerequisites/derived readiness, before-after measurements, write overhead, strict reader admission and exact activation gates. Selected synthetic Rehearsal scope never means excluded owner/all-owner readiness.
- Public Android downloads/metadata/links/QR and Windows version/release host consistency, authorized atomic replacement only. Existing public main/downloads are not this handoff branch.
- Final dependency/security review, full integrated regression and postdeploy live acceptance. Existing local proofs do not close all requested features/security gates.

## Reproducible starting commands

Use the repo's declared Node24.x and npm lockfile. Start with `npm ci --ignore-scripts`, `npm run typecheck`, `npm run build`, and inspect scripts/run-integration-tests.mjs before running integration groups. `npm test` and `npm run release:check` currently include legitimate stale-public-artifact failures; record them, do not delete tests or rewrite old metadata. Verify Android with official SDK/apksigner and documented certificate pins; signing keys remain outside git. Windows build recipe and candidate hashes are in docs/handoff/native/STATE.md.

Read-only/default review entrypoints must remain review-only. Local DB fixtures must hard-refuse remote connections. Some optional browser rehearsals reference temporary helper/toolchain paths and need normal local setup before rerunning; that is a reproducibility limitation, not permission to skip acceptance. Never run hosted SQL merely to make a local test pass.

At the start, summarize the actual runnable artifact and next release-critical action. Ask only for an uncovered consequential user decision after reading code and existing records. Do not ask the owner to repeat the project or approve already-approved work. Keep unfinished facts explicitly unfinished.
