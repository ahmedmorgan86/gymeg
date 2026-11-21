# Ordinary strict-key repair, held

All affected readers remain default OFF. No target schema or deployment is changed by this source commit.

## Actual-role failure and repair

A separate disposable local PostgreSQL 14 fixture had 5,000 members, 50,000 visits, 10,000 invoices, 1,000 payments and 100 open visits. Reads used `SET LOCAL ROLE gymos_app` with FORCE RLS unchanged. Supabase-only scheduler/network/vault signatures were local stubs, and no outbound handler ran. Local JIT was disabled because this installation lacks LLVM. This is not hosted PostgreSQL 16 acceptance or a capacity promise.

Before repair, the generated WhatsApp reverse-day query scanned the branch for every member: 250 index loops, each filtering 49,990 of 50,000 rows. EXPLAIN ANALYZE took 3.64 seconds under a separate 5-second diagnostic cap, while the real reader correctly refused at its 2-second cap. Portal occupancy similarly filtered 49,990 rows per loop over 100 candidates and took 1.61 seconds. JSON-expression member/range predicates stayed above the RLS security barrier.

Held migration `20261122020000_demand_strict_keys.sql` adds STORED generated ordinary columns:

- `demand_member_hash`: md5 of JSON-string member only; NULL for other types.
- `demand_visit_day`: bounded canonical-shaped JSON-string day for visits, preserving the original regex semantics, including invalid calendar-shaped days.
- `demand_visit_clock`: canonical validated effective clock, preserving activeAt ?? at and returning NULL on malformed dates/types.

Indexes use ordinary owner, branch, member hash and day/clock columns. Exact JSON equality/type checks still follow the hash lookup. No RLS, grant, role, security-definer or LEAKPROOF relaxation is made. Account own-row selection uses the same ordinary member hash. Its owner-wide allocation-reference scan is NOT fixed here.

After repair, actual-role generated SQL plans use all these index conditions under forced custom and forced generic prepared plans, with a second owner holding only 50 visits. WhatsApp SQL took about 1ms for 250 probes and portal about 0.8ms for 100 probes. A 15-call mixed run through a five-connection pool completed without refusals in roughly 11-92ms per request. These are warm local samples. A deliberate 250ms full-pool hold added that wait to the account request. Pool acquisition, connect, BEGIN/COMMIT and network time remain outside the SQL statement cap.

The inner portal clock probe orders only by clock and position, both indexed. Two identical leading clock/position rows cause explicit refusal irrespective of id order. This avoids sorting an arbitrarily large malformed id tie group to decide that the candidate must refuse. Outer ordering and the legacy first-position semantics remain unchanged.

## Backfill, writes and rollback

Real PostgreSQL backfill exposed an additional bug: the exception-catching calendar validator had been marked PARALLEL SAFE, but an exception block opens a subtransaction and failed in a parallel worker. Its held definition and the new migration now mark it PARALLEL UNSAFE. This is a scheduling restriction, not broader authority.

A 66,100-row local backfill plus index rebuild took about 1.97 seconds. Ordered source-payload digest, row count and owner-version rows were unchanged. Reversing the derived-column/index DDL also preserved the source digest. Generated values matched their expressions in every fixture row. Unit coverage includes numeric/null member keys, 40KB member/date strings, invalid calendar dates, leap-day clocks, null/false activeAt, updates and derived-data rollback.

Write overhead remains a real rollout consideration: three warm samples inserting 1,000 closed visits took roughly 75-97ms with the added keys/indexes, versus 56-60ms using only the preexisting indexes. The sequence/order and warm cache affect these samples. Existing expression indexes are deliberately retained for other readers, so this is duplicate indexing cost. No production throughput claim follows.

ALTER TABLE rewrites/backfills under a lock. A target rollout needs its own reviewed maintenance and concurrent-index plan, hosted PostgreSQL 16 actual-role plans/load and write-cost approval. Rollback starts by disabling all dependent readers, then drops only the new indexes and derived columns. Do not remove the older canonical function while its prior index still depends on it.

Remaining gates include member-credit/reference indexing, actual HTTP fallback semantics, remote connection/pool lifetime, larger/skewed fixtures and independent review. Successful local plans do not authorize activation.
