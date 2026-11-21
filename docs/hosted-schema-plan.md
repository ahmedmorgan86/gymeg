# Hosted schema execution plan (HELD, review only, never applied)

Scope: the unapplied demand-loading schema on `gymos.gym_entities`: 020000 (executor: 3 stored generated columns, 3 indexes, one function ALTER) and 030000 (this branch: refs tables/triggers, 4 stored generated columns in ONE ALTER, 8 indexes on gym_entities plus refs indexes). Nothing here is authorized to run. No hosted activation, no flag-on.

## What rewrites the table
- 020000: one `ALTER TABLE ... ADD COLUMN x3 ... STORED` (one rewrite).
- 030000: one `ALTER TABLE ... ADD COLUMN x4 ... STORED` (one rewrite; was four separate statements). Local measurement, scratch PG16.2, 180k synthetic rows, 42 MB, warm, one session, no concurrent load: one 4-column ALTER 382 ms; the same four columns as four statements 178+169+214+246 = 807 ms. This is a scratch measurement of the rewrite shape only. It does not predict production time, WAL volume, replica lag or lock wait.
- A further saving is possible only across migrations: the 7 generated columns of 020000 and 030000 can be added by ONE ALTER (one rewrite instead of two) if both migrations are run as one reviewed maintenance script. The migration files stay separate for review; the executor owns 020000. Pending executor agreement, not done.

## Execution rules for the hosted runner (not the transactional migration runner)
1. Run in a maintenance window with readers of the new routes OFF (all flags default OFF).
2. `SET lock_timeout='2s'` (judgment number, label it so) and retry the ALTER with backoff. The ALTER takes ACCESS EXCLUSIVE and queues behind any long transaction; check pg_stat_activity first. Never run it while a long reader or the restore/import path is open.
3. Column ALTER inside its own short transaction. Indexes outside any transaction with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, one at a time, then verify `indisvalid` for each (an invalid leftover must be dropped and rebuilt). The migration files use plain `CREATE INDEX IF NOT EXISTS` for local rehearsal; the hosted script replaces them with the CONCURRENTLY form.
4. `maintenance_work_mem` raised for the session only; watch WAL and replica lag between steps.
5. Refs backfill (`invoice_allocation_refs_rebuild`) per owner after the schema exists, then readiness; see docs/refs-restore-runbook.md. Backfill cost is separate and not measured here.
6. Rollback: drop the new indexes, then the generated columns (one ALTER DROP COLUMN each set), readers default OFF so no reader depends on them.

## Local index build times (scratch, same 180k rows, after the columns exist)
pay_day 77 ms, pay_day_odd 13 ms, visit_odd 12 ms, visit canonical order 72 ms, member-odd 16 ms. Plain (blocking) builds; CONCURRENTLY is slower and was not timed.

## Not measured / open
Write amplification of the generated columns and 8+ indexes on insert/update at production concurrency; backfill duration on real data; replica lag; CONCURRENTLY build time; behavior under the pooler.
