# Automatic WhatsApp demand reads, held

Default OFF: `GYMOS_WHATSAPP_READS=1` opts PostgreSQL into this candidate. It does not activate a cron or authorize sending. No deployment, live migration application, real-account WhatsApp outbox generation or WhatsApp send was used for this work.

## Read and consent behavior

- API branch validation reads metadata, not full state, when enabled.
- Due-job enumeration uses keyset pages of 250 members plus one lookahead row. It reads no photos or unrelated collections. `dueMessages` remains the oracle and accepts an optional latest-visit map.
- Absence uses up to 250 reverse-day LIMIT 1 probes. Exact member equality follows the hash predicate, with branch, canonical-day predicate, JSON string type and C collation. Held migration `20261121230000_visit_member_branch_day.sql` supplies the intended index. The irregular-day/at probe now uses the shared transaction-local index-probe wrapper, restored after the query.
- Owner versions are checked before and after each page. No job-result cache. Missing prerequisites, odd history, races and read errors DEFER the enabled run. There is no full-state fallback in enabled run enumeration or send revalidation. Default-OFF retains the legacy path.
- Pending delivery rechecks current rule, branch, current member due status, phone, archive/demo state, occurrence and stored opt-out. If these cannot be verified, the job goes back to pending with a named deferral. If an outbound request was attempted and its result is uncertain, it remains unknown and is never automatically retried.

## Durable continuation and fairness

Held migration `20261122000000_whatsapp_scan_cursor.sql` adds owner-RLS cursor rows. One owner/rule advisory transaction lock protects each page. The page's deterministic outbox batch is one INSERT, and its next member cursor advances in the SAME transaction. Failure or deadline rolls both back. On completion cursor becomes null, so a later run starts a fresh full pass. This does not truncate results or require retaining the process.

A run processes rules oldest-progress-first, one page per rule per round. A rule with more members rejoins the queue after its peers. Deadline stops further pages; subsequent invocations resume from stored progress. Deterministic outbox ids and ON CONFLICT retain idempotency through wrap-around. Writers can move members across a cursor, so a later full pass may still be needed, as with any changing paged population. Fresh individual consent is checked again before sending.

## Budget and remaining caveats

The existing run deadline is checked before each enabled-mode SQL statement, page batch and cursor advancement. Each real SQL statement gets min(2 seconds, remaining budget) statement_timeout. Provider timeout is min(15 seconds, remaining budget minus a 2-second settlement reserve). After delivery, terminal status and stale-sending cleanup each have their own 2-second bookkeeping budget. No per-job INSERT loop or unbounded full-state fallback remains in enabled mode.

This is NOT a guaranteed 40-second HTTP bound. Pool acquisition, network delay, transaction BEGIN/COMMIT/ROLLBACK and the bookkeeping envelope remain outside that simple clock guarantee. A provider request can have an uncertain result. Real PostgreSQL generated plans, concurrent writers/runs, cursor lock contention, pool saturation and actual timeout/connection-release acceptance are still owed. Statement timeouts are not row-scan bounds. No lower total cost or activation readiness is claimed. The shared planner setting and held indexes remain under independent review.

## Local evidence only

- Selector differential: disposable PGlite, 577 members, four visits/member, two owners, seven rule kinds across three clocks; consent revocation, odd-day deferral, numeric member-key non-coercion and version changes.
- Durable enumeration: 250/250/77 member pages over independent transactions, persisted continuation, wrap without duplicate ids; injected deadline after bulk INSERT rolls rows/cursor back; malformed layout/missing cursor table defer without progress.
- Mocked sender: current consent/phone/opt-out/rule cancellation; unavailable revalidation becomes pending and does not full-read or send. All external fetches forbidden. No real provider acceptance is implied by these tests.

Fresh serving deployment and native application acceptance are separate from this held implementation.
