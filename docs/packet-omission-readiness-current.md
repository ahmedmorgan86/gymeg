# Browser packet omission readiness, 2026-11-24 01:48 Cairo

Local engineering inventory only. This document is not permission to activate readers, change production, deploy, mutate account data, send messages, or remove preserved artifacts. `OMIT_READERS_COMPLETE` remains false. No flag combination can enable omission in the product build.

## Changes from the current consumer audit

- `549edc3`: admission now includes the separately gated quota-issues reader. Without it Overview, global search and member filters could classify visit-limited members from omitted history. Negative admission test passes when every other flag is ON and quota is OFF.
- `c32c0b2`: Overview's follow-up card no longer directly counts absence templates from an omitted packet. It uses a separate day-bounded last-visits read. The member table's ALL_DAYS request cannot substitute because future visits must not suppress an absence due today. Default OFF uses the original full-packet expression. Strict loading/error is unknown, never zero or fabricated absence. Actual Workspace, real local route and PGlite fixture: full packet OFF and reduced-visits STRICT converge to count3 in Arabic and English; 503 shows dash and Retry; Retry converges; 390px has no overflow. Component and domain regressions also pass.
- `c9b3b49`: delta packets retain the original snapshot serverNow. Workspace previously reset the local receipt anchor on every delta, freezing effective server time and rejecting real recent entries as future. A clock-anchor helper now preserves that anchor when scope and snapshot clock are unchanged. Real applyWorkspaceDeltas regression proves a check-in 180seconds after snapshot is seen; old re-anchoring misses it. New snapshot and account-scope changes reset the anchor.
- Actual domain exit/reentry tests disprove the old comment that daily visit IDs never reopen. Normal visit.add/scan reuses the ID but advances activeAt. Four real exit/reentry cycles match both legacy and open-reader popup selectors. The comment is corrected. An unchanged-key reopen still differs between an open-only previous map and legacy's complete previous map; normal monotonic reentry does not create it.

- `a845e4d`: actual Workspace fixture exposed missing initial branch baseline. Polling started for main before the first packet selected branch a, so its response was discarded and the first real check-in became a silent baseline. Scope-change baseline effect now covers branch/owner/actor/role/generation and response guards bind actor+role.18 actual Workspace local browser checks pass.
- Real useOffline/IndexedDB local browser fixture passes11 cache/outbox checks. Capability is overridden only inside the test bundle, never in product source.

- Advanced profile now exposes visit-count failure+Retry instead of discarding those hook fields. Real local detail/history routes and reduced packet verify all40paged rows, exact order and Retry in desktop/mobile EN and mobile AR.

## Composed all-reader navigation acceptance

New actual Workspace harness enables all nine visit-reader flags together and feeds an actually omitted-visits packet. Routes use the real local PGlite database and packet projection. Full packet OFF is the oracle. Owner branch-a EN19/AR19, branch-b manager EN19/AR19, and branch-a reception EN17/AR17checks passed. Covered six main sections where role permits, global search status, real detail entry and populated paged history, advanced profile count/history, no mobile page overflow, attendance failure/Retry and no navigation writes. Browser clock is fixed for both variants to compare durations exactly. This does not establish every role/language/branch combination, every reader failure/loading path, complete history ordering, service-worker offline/reconnect or long-lived deltas.

Visual inspection exposed advanced profile behind the priority drawer. Workspace now unmounts the drawer while advanced profile is open, preserving its parent selection so Close returns to the drawer. One accessible dialog, topmost mobile Close control and AR/EN pixels are verified. Full build and typecheck passed after this local application correction.

## Candidate-source strict failure repair

The composed failure audit found MemberConsole ignored the index source and displayed legacy statuses from the omitted empty visits list while candidate reads were loading/failed. The hook now exposes scope-keyed failure and Retry. Strict MemberConsole shows loading or an explicit unavailable state instead of fabricated metrics/rows; default-OFF and non-strict legacy fallback are preserved. Actual all-reader Workspace forced candidate503 in EN/AR passes22checks per language including no fabricated table, Retry exact full-packet parity and the existing navigation/profile checks.11summary-model tests, typecheck and full build pass after the repair. All42registered local integration suites have since been rerun on application HEAD57d225d in six bounded groups, zero failures. Final all-reader forced-candidate-failure matrix also passes ownerEN22/AR22, manager branch-bEN22/AR22, reception branch-aEN20/AR20.

## Broader composed failures and offline shell

All-reader Workspace now verifies independent503+Retry for today-visits, last-visits, present-visits, visit-trend and quota-issues in both EN/AR. Each shows unknown/error (DailyHome uses dash+Retry) then returns to exact full-packet section text after Retry. These are separate local synthetic cases, not all combinations or timeouts.

An actual public/sw.js service-worker run (not a stub) caches the recognized test Workspace shell and asset, reloads /?workspace=1 with browser networking disabled, restores the reduced IndexedDB packet, and shows unavailable candidates rather than fabricated rows. Actual Workspace Operations scanner persists one offline queued check-in without claiming server success or POSTing. Reconnect replays it once through the actual local POST route, persists exactly one visit in PGlite, clears the queue, and restores server-derived state.11checks pass. Mobile pixels inspected for offline unknown state and queued-not-approved receipt. This uses bundled synthetic assets, owner/EN only, and is not acceptance of production Next asset manifests, all roles/languages, installed clients or identity changes during offline replay.

## Full composed history and detail failures

Actual Workspace owner EN/AR with35visits per member now loads every history page. Console history timestamps exactly equal the legacy member-filter+reverse order; advanced profile timestamps exactly equal the legacy at-descending order.20checks pass per language. Separate composed member-detail503 and console-history503 cases each pass22checks per language: unavailable error, no fabricated status/rows, Retry and subsequent full-state parity. Histories use distinct real local routes, not intercepted prebuilt rows. This still does not cover every loading delay, race, restore epoch or role on these failure variants.

## Real local delta composition

Actual local visit.exit mutation plus real changes route drives both full-packet and reduced all-reader Workspaces to revision6. Presence/history changes appear, then MemberConsole, expanded Overview, member table, Operations and manual WhatsApp re-navigation each match the full-packet peer after reader invalidation/refetch.9checks pass in EN and AR. Browser tabs are brought to the foreground and required to reach revision6 before comparing; synthetic visibility events on a hidden tab do not establish a completed delta pull. This covers one exit/revision, not long-lived bursts, restore epochs, removals or cross-owner reload.

## Actual local restore composition

Actual persistSpace restore rotates the epoch and removes all visits. Real changes-route snapshot recovery brings both full/reduced Workspaces to revision6. Attendance tables have zero visit rows and the local DB oracle confirms zero; MemberConsole, expanded Overview, members, Operations and manual WhatsApp all match after refetch.10checks pass in EN and AR. Restore test snapshot uses the real packet projector and lazy header, preserving the omitted marker. This covers one successful restore, not interrupted restore, account changes, queued attendance across restore or production provider grants.

## Queued replay identity guard in actual Workspace

Actual service-worker/offline Workspace test now repeats with a fresh snapshot returning a different owner, actor or role before the queued POST. All three variants block POST, retain exactly one item under the original IndexedDB queue key, and replay exactly once through the real local route after the original identity is restored (reload allowed if the changed identity has already caused Workspace state/queue refresh).13checks pass per variant. Do not describe recovery as automatic without reload in every variant. This checks a mismatching snapshot against a held queue, not successful account switching or permission grants. Queued restore-epoch refusal now passes the case below.

## Queued attendance across restore

Actual Workspace/service worker offline scanner queues a pre-restore visit, local persistSpace rotates epoch, and the fresh snapshot is served from actual post-restore storage. Reconnect submits once to the real local POST route, gets conflictOffline, persists no visit, and retains the queue item paused with conflictOffline for manual review.10checks pass. An earlier fixture incorrectly served a stale revision5 snapshot after restore and retried revision conflicts; that was a fixture error, not accepted evidence. Current test serves the real fresh snapshot before checking the epoch refusal.

## Actual Next production asset shell

Isolated local copy builds actual Next production HTML/chunks/CSS with the real service worker. A synthetic Workspace-only page replaces authentication only in that throwaway copy, never in product source.31cache entries are prepared, offline navigation boots actual Next chunks and restores a full synthetic IndexedDB packet with honest remote-reader unavailable states.390px Arabic pixels inspected. This closes an asset-format question, not shipped omission/auth acceptance: product hardfalse was not overridden in this build, APIs are synthetic, and reduced packets were tested separately in the esbuild all-reader fixture. Local copy and harness remain preserved outside this source branch.

## Complete local integration regression

The integration registry now includes the existing synthetic canary-materialization suite. A stale quota rollback fixture tried to fail the tenth summary INSERT, but the selected branch has only21 marks and writes five summaries per batch. It now fails the second batch and still requires exact dirty-mark and stored-summary rollback plus a usable connection. Production budgets and error handling were not changed. The separate slow-statement deadline test still passes.

All42registered local integration suites passed, run in bounded groups because the combined runner exceeds the execution window. No local suite was skipped. Three external suites remain prerequisite-gated and were not executed: live dev-server API, real-PostgreSQL commercial restore, and real-PostgreSQL support RLS. Six DB-gated unit suites remain outside this local integration result. This is local regression evidence, not full release acceptance.

## Source-grounded consumer map

| Consumer | Current source | Evidence and remaining acceptance |
| --- | --- | --- |
| DailyHome today count | useTodayVisits | Actual all-reader reduced/full navigation parity and503/Retry EN/AR covered locally; not real-auth/device acceptance. |
| Operations latest-today | useTodayVisits | No direct history count when strict source unknown. Reception error classification receives workspace quota function. |
| Operations current presence | usePresentVisits | Uses latest eligible visit including closed rows before presence, not open-only endpoint. Local newer-closed disqualification and actual all-reader reduced/full navigation covered; wider operational/device acceptance not established. |
| Attendance table | useAttendance | Actual all-reader reduced/full navigation, scoped role matrix and503/Retry covered locally. |
| AttendancePresence | usePresentVisits | Converted to exact latest-eligible semantics; do not revert to open-only endpoint. |
| Overview chart | useVisitTrend | Actual all-reader navigation,503/Retry, restore and bounded48-exit parity covered locally; prolonged load remains open. |
| Overview active/renewals/ring, global search, member status | useQuotaIssues | Admission missing-flag repaired. Existing dedicated quota browser harness is not whole-app evidence. |
| Member table last visit | useLastVisits with ALL_DAYS | Deliberately no upper date clamp, matching legacy member table. |
| Overview follow-up count | WhatsAppDueCount -> useLastVisits today | Newly repaired and actual Workspace mobile AR/EN tested. |
| Dedicated manual WhatsApp | useLastVisits today | Already reader-backed with strict unknown/Retry. No automatic sends are caused by count computation. |
| MemberConsole detail/history | member-detail and paged history | Strict detail refuses fallback. Actual Workspace35row complete history,503/Retry and delayed selection responses EN/AR covered locally. |
| Advanced MemberProfile | useMemberDetail + MemberVisitPager | New actual profile historyON fixture passes desktop/mobile EN and mobile AR: full40row paged history equals legacy order, count40, countfailure dash+Retry restores40, tabs reachable/nooverflow. HistoryOFF fixture separately proves explicit unavailable. Full Workspace advanced entry/count/history composition now passes the scoped scenarios above. Pixel inspection caught and repaired the drawer stacking defect. Wider roles/languages, other role/branch paging combinations and device acceptance remain open. |
| Automatic check-in popup | open-visits + checkinPick | Domain and delta clock tests pass. Actual Workspace reduced-packet browser fixture now passes18checks in AR/EN for snapshot+180s delta, failed interval/Retry, duplicate suppression, initial branch and branch return. Expanded actual Workspace fixture now passes42checks total in AR/EN, including delayed member arrival with exactly-once recovery and actor/role/generation snapshot baselines followed by the first fresh entry. The held old-actor open response is discarded after a new actor snapshot/baseline. Separate synthetic successful owner-context reload now covered below; real-auth/account-selector acceptance remains open. |
| Offline packet/replay | useOffline packetUsable + capability headers | Real hook/IndexedDB browser fixture passes11checks: reduced-cache version guard, queue persistence across remount, exactly-once replay, tenant/capability headers, wrong-owner fresh snapshot refusal and retained queue, correct-scope retry. Actual Workspace with real service worker now passes the owner/EN shell reload and queued local-route replay case described above; actual Next assets pass in a separate full synthetic isolated page, not a shipped reduced/authenticated artifact. Composed owner/actor/role mismatch guards and restore rejection covered with reload/manual-review limits; all role/language/device combinations remain open. Offline shell cannot make remote strict sources available. Unknown states must remain honest while queued check-ins still reconcile. |
| Realtime deltas | applyWorkspaceDeltas | Omitted collections stay omitted while revision and state identity advance, causing sources to refetch. Actual48exit/revision53 composed convergence EN/AR covered; prolonged/concurrent/real-clock load remains open. |

QuickVisit plan.visits and MemberAccount period.visits are quota fields, not browser packet history consumers. Member portal data comes from its separate API, not the staff workspace packet.

## Remaining blockers before omission can be considered

1. All-reader actual Workspace navigation now passes the scoped owner AR/EN, manager branch-b AR/EN and reception branch-a AR/EN scenarios above. Remaining composed acceptance includes the other role/language/branch combinations, every remote-reader loading/error/Retry path, wider history cases and long-lived cache/delta changes.35row owner EN/AR complete paging,48exit convergence and restore recovery are now covered as described above. Do not promote scoped navigation parity to whole-release acceptance.
2. Actual popup browser chain now covers delta-only changes after old snapshot, failed read/Retry, duplicate suppression and branch switch/return; delayed member arrival and actor/role/generation changes now pass in the expanded42check AR/EN Workspace fixture. A held old-actor open response is discarded after the new actor snapshot/baseline. Separate synthetic owner-context reload is covered, not real auth/account selector. Open-only prior history has an explicitly unclosed unchanged-key edge.
3. Actual Workspace real-service-worker owner/EN shell/reconnect now proves honest remote-source unavailable states and one queued replay; composed owner/actor/role mismatch replay guards and restore rejection now pass locally, with reload/manual-review limitations documented above. Real useOffline/IndexedDB fixture now proves packet-version guard, tenant binding, no partial visit repopulation, persistent outbox and replay safeguards. This is functional readiness, separate from network performance.
4. Run a full production build and the relevant complete regression group on the final integrated tree, then independently review the exact flag/source deployment delta. No activation or rollout authority follows from these local changes.

## Separate full-demand work, not browser omission blockers by name alone

Full-report export, automatic WhatsApp, device ingest and member portal hydration load server data independently. Their retained full-read fallbacks, actual-role plans, write-lifetime/capacity/concurrency and allocation scan concerns remain in `performance/server-read-inventory-held.md` and `performance/strict-key-repair-held.md`. Reducing the browser packet does not close those gates. Conversely their full-state server fallbacks do not prove a browser still needs packet history.

The protected Rehearsal member-list/detail preview and its selected derived version1 were accepted on a separate dedicated source line. It keeps full packets and does not establish the broader local branch's flags, UI consumers, performance, offline, native, Google, notification, dependency or release acceptance. Production remains outside this work's mutation scope.

## Short burst extension

Owner EN actual local nine-write exit burst reaches authoritative revision14 before comparison. All-reader attendance and subsequent Console/Overview/members/Operations/WhatsApp navigation retain full-packet parity.17checks pass. This is a short bounded burst, not prolonged load/races or AR acceptance. Successful cross-owner reload remains open.

## Synthetic successful owner reload and delayed candidate response

Actual Workspace EN/AR starts on local ownerA, server context changes to separately seeded ownerB, and changes-route snapshot recovery returns ownerB. Workspace performs a full document reload, then real local ownerB candidates populate and old member names are absent.6checks pass per language, no browser writes. This is synthetic server-context switch, not real auth/account-selector acceptance.

Separate EN/AR race holds a branch-a candidate response after its real local route read, switches to branch-b, waits for branch-b candidates, then releases the old response. Branch-b text stays exact.4checks pass per language. Abort/cancellation remains active, so this does not establish a forced post-abort JavaScript continuation or all detail/history races.

## Additional delayed responses

EN/AR delayed quota-issues branch response and member-detail selection response pass4checks each per language in actual Workspace with local routes. Quota branch-a response is held, branch-b issues re-read completes, old response release preserves exact branch-b text. Detail holds first-member response, closes drawer, selects another member and verifies no loading/error, then old release preserves exact current drawer. Normal abort/cancellation remains active, not forced post-abort execution. No browser writes or application changes.

## Bounded48-exit convergence

Synthetic48-member/240-visit local fixture runs48actual exit POSTs, revisions5through53, interleaving foreground delta pulls every8writes. Reduced all-reader versus full-packet attendance text converges at all6intermediate checkpoints and final, then console/overview/members/operations/WhatsApp parity passes.62checks per language EN/AR. Browser navigation writes zero; mutations are direct local test requests. This is roughly one minute per language, sequential writes with250ms waits and checkpoint pauses, not prolonged load/concurrent users, quota max-wait timing or real DB load acceptance. Fixed browser clock preserves parity and is not evidence of elapsed-clock freshness.

## Delayed member history selection

EN/AR actual member-history route response for first member is held, drawer closed, another member selected and its history article populated, then first response released. Exact current drawer remains unchanged.4checks each language, no browser writes. Normal abort/cancellation active.
