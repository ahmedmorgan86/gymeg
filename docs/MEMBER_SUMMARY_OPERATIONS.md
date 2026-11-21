# Member summaries: readiness, recovery, cost (held, nothing applied)

Readiness is per owner (row in gym_member_summary_ready). Readers use summaries, the maintained dues total and the candidate list only while the owner is ready; otherwise they take the exact legacy path (packet or exact scan).

Readiness is STICKY once lost. It is lost when: an owner is created with existing rows (no automatic ready), TRUNCATE of gym_entities, or a write whose member key is longer than 1024 bytes (the write succeeds; the key is not queued).
Recovery, one owner at a time, by whoever applies the migrations: `SELECT gymos.backfill_member_summaries('<owner>')`. It clears that owner's summaries and queue, queues every member with a key within 1024 bytes, and makes the owner ready only if no member key of the owner (members, visits, payments, invoices) exceeds 1024 bytes. If one does, the owner stays on the exact legacy path and the call is a no-op for readiness; removing or shortening the offending key and calling backfill again restores readiness. Readers drain the queue in waves of REFRESH_MAX (500) per request; until it is empty the member list and dues total are exact but recomputed on demand or scanned.

Measured on PG16 sandbox (owner E, 10,000 members, 20,000 invoices, 12,000 visits for one member):
- backfill call: 33 ms (marks 10,000 members dirty and sets ready).
- queue drain: 500 members recomputed per wave in about 250 ms, about 20 waves for 10,000 members.
- write overhead, one INSERT statement of 6,000 visit rows inside a transaction (rolled back): all six new indexes plus triggers about 206 ms; no new indexes and all user triggers off about 63 ms; triggers only about 79 ms; the six new indexes only about 170 ms. That is about 19 microseconds per row for the six expression indexes and about 3 microseconds per row for the triggers (counters, member-summary dirty marks, card sync). Single-row writes pay the per-row figure. Bulk imports and restores pay it per row, so create the indexes after a bulk load or accept the cost. Only Postgres time on a sandbox, not a Supabase pooler measurement.
