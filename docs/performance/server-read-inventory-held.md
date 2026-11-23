# Server read inventory, held integration

All new flags below default OFF. This is an implementation inventory, not deployment or capacity acceptance.

| Path | Candidate state | Retained full-read cases / debt |
| --- | --- | --- |
| Automatic WhatsApp | GYMOS_WHATSAPP_READS. Paged reverse-day selector, durable atomic cursor/outbox batches, separate enumeration phase and delivery reserve. Fresh single-member send checks. | OFF retains legacy. ON defers instead of full fallback. Real PostgreSQL/pool/concurrency acceptance pending. |
| Phone/PIN session validation | GYMOS_MEMBER_SESSION_READS. Exact account member+branch slice and metadata. Auth/PIN/rate/license and matched-club disclosure unchanged. | Legacy layout / slice backend fallback still full. At most20 account candidates from existing login projection. |
| Device gateway ingest | GYMOS_DEVICE_EVENT_READS. After original HMAC gate, metadata mapping + revision-consistent existing hot hydration, global counts, byte proof and partial persist. | Full fallback on legacy/unready/caps/races/trim windows. Metadata still carries global engagement device replay list. No real device gateway mutated for testing. |
| Member financial detail | GYMOS_MEMBER_ACCOUNT_READS. GET /api/member-account-detail pins owner/member/branch to codeMemberIdentity. Query parameters never choose identity. | Unavailable503 for unsupported layout, version change, >5000 own rows or related allocation inputs, timeout. No partial result. No browser wiring in this change. |
| Member portal projection | GYMOS_MEMBER_PORTAL_READS. Existing own-member slice skips other open-member histories; separate canonical-clock reverse probes select <=2 latest eligible visits per open member and supply occupancy only. | Own-member history/reference payload is still complete, not paged. Legacy/disabled/race/oddclock/caps/ties retain existing hydration (which may load all history for open members or full state). New held clock function/index needs actual PostgreSQL/write-overhead review. |
| Member message write | GYMOS_MEMBER_MESSAGE_READS. Complete community metadata plus referenced message members (up to1000 ids), exact validator/rate/replay checks and existing partial persist byte proof. | Full fallback for legacy/missing activity archive/counters, >1000 referenced members, events trim boundary or failed size proof. Community remains global metadata, not a row-paged store. |

## Member-account API contract

GET /api/member-account-detail, flag GYMOS_MEMBER_ACCOUNT_READS=1. Authenticated code-member cookie required, pin_must_change rejected. Current club license must permit writes, as on the existing member portal. Firestore501. Missing member404; auth401; PIN/license403; unavailable503. Browser-selected member/owner/branch arguments are ignored.

Success: `{status:'ok', memberId, branch, revision, version, payments, invoices, credit, outstanding}`. Financial rows include own member and own branch only, retaining original order and voided records. No member profile, health, photo, settings, other owner, or other member financial rows are returned.

Credit follows the existing memberCredit/paymentAvailable function exactly. That function subtracts matching allocations from ANY non-void invoice, even an old malformed cross-member/branch reference. Those related allocation arrays are read privately in owner scope, in original invoice order, and are not returned. This probe currently has no allocation-specific index and may scan owner invoice rows. It has a remaining-budget statement cap and a5000-row output refusal, not a proven cheap plan. It must undergo generated-plan/load review before activation. Outstanding uses invoiceOutstanding over own-branch payment/invoice inputs.

This route is distinct from the staff `/api/workspace/member-detail` API, where authenticated staff may select a member in their authorized branches. `app/member-account.tsx` is a staff member-profile component, not proof of member-session authorization.

## Portal occupancy candidate

GYMOS_MEMBER_PORTAL_READS defaults OFF. One request clock is passed through member hydration and projection. The existing memberView computation accepts an optional verified occupancy count; its legacy behavior is unchanged without it. No other-member latest-visit rows are returned in the response.

The selected member still needs their own complete history for the current API. Other branch members' history is replaced with <=2000 open candidates and <=2 reverse effective-clock probes/member, preserving presentVisits latest <= now, activeAt ?? at, first-in-position-order on tied clocks, closed-latest and auto-exit behavior. Malformed clock/calendar, malformed/falsy leftAt shapes, coerced numeric member keys, >2000 candidates, unstable duplicate position/clock ties or owner version changes refuse the candidate and keep the old exact hydration. Owner version is checked around the whole composed hydration, not only around occupancy.

Held migration20261122010000 adds a conservative canonical UTC-clock function with exception-to-false behavior and clock/irregular partial indexes. It does not reject malformed old data. Its function/index CPU and write overhead, planner behavior, pool/concurrent load and total portal lifetime are NOT yet measured. The read has a4-second callback clock and2-second statement cap; output bounds are not scanned-row bounds. The canonical function and collation semantics need independent review before any activation.

## Actual-role strict-key correction

The expression-index cheap-plan assumption was disproved on disposable actual-role PostgreSQL14: WhatsApp and portal reverse probes scanned whole branches per selected member under FORCE RLS. See `strict-key-repair-held.md`. Held20261122020000 adds generated ordinary member/day/clock keys and the owned readers now use them. Generic/custom actual-role local plans and concurrency improve, but the member-credit allocation scan and target/write-lifetime gates remain open. Calendar validator is now PARALLEL UNSAFE because its exception block cannot run in a parallel worker. None of this SQL is applied to a remote target.
