# Automatic WhatsApp demand reads, held

Default OFF: `GYMOS_WHATSAPP_READS=1` opts PostgreSQL into the candidate read path. It does not turn on a cron or authorize a send. No deployment, migration application, real-account outbox generation or live sending was used for this implementation.

- API branch validation reads metadata instead of the full state when enabled.
- Due-job enumeration uses keyset pages of 250 members plus one lookahead row. It does not read photos or other collections. `dueMessages` remains the oracle and accepts an optional latest-visit map.
- Absence uses up to 250 reverse-day index probes, each with LIMIT 1, with exact member equality after the hash predicate, branch, canonical-day predicate and C collation. The held `20261121230000_visit_member_branch_day.sql` index is a prerequisite for the intended plan. An indexed irregular-day/at probe refuses malformed branch history.
- Owner change versions are read before and after each page and carried between pages. No job-result cache is used. Missing version/layout, odd history, races and read errors go to the full legacy path. Already enumerated jobs retain their original deterministic ids and ON CONFLICT behavior.
- Before sending a pending job, the code re-reads current rule and current member due status for that single member, and checks current phone and stored opt-out. Consent, archive/demo state, occurrence and branch checks remain required. Tests cover cancellations only, with all external fetches forbidden and database/outbox operations mocked.

## Bounds and caveats

Page output has at most 250 jobs. Statement timeout is 2 seconds per statement, not a whole-request deadline. Member-page sorting and probe efficiency require real generated PostgreSQL plans and load acceptance. Absence fallback can still read the full state. Enumeration spans all members/rules over multiple transactions; the existing 40-second deadline is checked between demand pages, not a guaranteed HTTP deadline or a total outbox-insert bound. No lower whole-run cost, concurrency capacity, or activation readiness is claimed.

The new tests use a disposable local PGlite database, 577 synthetic members, four visits per member, two owners, seven rule types across three clocks, consent revocation, odd-day fallback, numeric member-key non-coercion and version changes. Sender cancellation checks are module mocks only, not provider or device tests. Fresh serving production is separate and unchanged.
