# Held additive demand candidate

Latest evidence is local PostgreSQL 17.12, actual captured affected-table metadata, synthetic rows only, non-super migration role with BYPASSRLS and restricted runtime. No source production DDL or deploy occurred.

Read files in this order:
1. manifest.json, source hashes, exact new object names and explicit limitations.
2. expected-baseline-catalog.json and baseline-snapshot.mjs, affected original metadata and read-only semantic comparison.
3. preflight-held.mjs, fail-closed read-only admission draft. It needs an explicitly isolated connection. It does not verify owner authority or SSL endpoint identity and never applies SQL.
4. 01-schema-held.sql, one transaction, 7 stored generated columns in one rewrite, 31 new writer hooks, new derived tables/functions/roles. It still includes source CREATE OR REPLACE/DROP IF EXISTS statements, so reviewed preflight absence and existing baseline equality are mandatory, not optional. Never invoke this file directly against production.
5. 02-indexes-held.sql, 14 concurrent index statements. Execute separately outside transactions. The expected definitions, validity and readiness must be checked, not inferred from IF NOT EXISTS.
6. 03-rollback-held.sql, exact new hook/object reversal. It restores the captured affected baseline only when no new dependent object or application reader has appeared. It is not permission to drop unknown objects or restore customer data.

## Evidence

The acceptance run verifies full captured affected columns, owners, grants, constraints, policies, functions, triggers and index definitions before mutation and after reversal. It rejects a deliberately colliding candidate function and a one-character photo constraint drift. It forces an ACCESS SHARE blocker, sees lock timeout SQLSTATE 55P03 at about 2s, rolls back and checks complete metadata equality. It then applies the candidate, builds all indexes concurrently, runs 4 restricted clients / 40 committed invoice writes with exact refs, injects a derived ref writer failure and checks source update rollback, reverses and verifies original active card and committed invoice payloads preserved.

This is local controlled concurrency, not production throughput. Baseline table size is not a lock-duration promise. A 15s statement timeout is not a 15s transaction deadline.

The existing isolated provider separately has the expected maintenance-role non-login/non-bypass attributes, creator ADMIN membership from supabase_admin with SET/INHERIT false, no schema CREATE, no runtime refs INSERT and correct definer owners/search paths. That readback is not a first-run hosted execution of this combined candidate.

## Safe execution request that remains

Review the exact source and baseline snapshot, including all 31 hooks and the added write cost. Decide whether the combined local non-super proof plus separate actual provider edge proof is sufficient for a narrowly authorized production maintenance step, or require an independently reviewed hosted-first-run containment path. Existing isolated gymos already contains these objects, so replay is refused. Renaming schemas does not automatically preserve function trigger-context semantics.

If production execution is later approved, that approval must name original project, object manifest, maintenance window, 2s lock-abort behavior, 7-column rewrite and 14 concurrent indexes, backfill/readiness scope, rollback effects, and which flags (if any) may change. Current permission is none of those effects. Keep every app reader / Support sender flag off until readiness and separate acceptance. Do not change Auth, Google, SMTP, customer accounts, native artifacts or public download metadata as a side effect.

## Reproducibility limitations

The rehearsal shell paths are local evidence paths. hosted-launch-review-only.mjs is the separate portable launch adapter, defaulting to a printed REVIEW_ONLY manifest without a connection. Its explicit execution switch is never owner authority. It reads migration password and CA from private file paths, hardpins the original target, verifies baseline/collisions/migration-role/activity, runs schema then each concurrent index, stops without auto-retry or auto-drop, and never backfills or flips flags. It still requires review and exact owner approval before use. assemble.py regenerates phase 1 and phase 2 from pinned source; reversal, baseline and acceptance are separately reviewed source files. Do not run the assembler and assume every derived artifact remains synchronized without checking the manifest and diff.

## Final adapter review contract, v2

`reviewed-artifacts.json` pins the reviewed SQL, manifest, baseline and candidate snapshots, helper modules and the adapter itself. At execution, its SHA256 must equal `GYMOS_APPROVED_REVIEW_MANIFEST_SHA256`, carried independently from the approved review, not read back dynamically by the production operator. Every file hash is checked before any schema work. A changed pin file or source is a new review.

The adapter starts a transaction, takes ACCESS EXCLUSIVE locks on the four affected source tables with a 2s lock timeout, then compares the full fresh baseline and all candidate collisions before the first DDL. It does not release those locks between admission and schema commit. The original schema file's outer BEGIN/COMMIT are removed by anchored single-occurrence checks, retaining its contents in that same transaction. This widens the explicit lock set to all four affected tables. A separate, approved exclusive administrative DDL window is required: relation locks cannot prevent a second administrator changing schema-level ACLs or roles. A busy transaction causes a stop, never a retry loop.

Before schema commit, exact phase-1 semantic metadata and the provider role membership edge must match. After each concurrent index, its full definition and valid/ready states must match. Final postflight compares complete affected/candidate columns, functions (owner, security, search path and ACL), tables/indexes (owners, RLS/FORCE, ACL), constraints, policies, all hooks and enabled states, maintenance-role attributes/settings, schema ACL and default ACL. The hosted CLI requires precisely the separately observed supabase_admin creator ADMIN edge with SET and INHERIT false. The local test uses sandbox as grantor explicitly, without treating that as hosted proof.

The postflight reference is generated by the faithful local apply and checked as reviewed source, not synthesized from the just-mutated production database. No customer payload is selected by these metadata checks. Stored generated columns rewrite storage but do not edit original payload values. No backfill function is invoked. No app reader, Support sender, deployment, account, Google, Auth or SMTP change is included. Readers must already be OFF and remain OFF even after success until a separately approved readiness stage.

If an index fails after schema commit, stop. There may be a partial set of new indexes or an invalid index under a manifest name. The adapter never drops or retries one automatically. Inspect its schema, name and definition against the exact manifest and obtain the reviewed cleanup/reversal decision. Unknown objects and original indexes are never cleanup targets. Full reversal has no CASCADE and is separately reviewed; it must preserve original table payloads and original functions/hooks. It is not a customer-data restore or proof of managed Auth/config recovery.

## Maintenance bounds correction

The branch-summary source tail's 5s/60s local timeout overrides were removed from the held schema, now consistently 2s lock / 15s statement. The assembler skips source-level lock/statement settings so they cannot silently return. The adapter additionally sets PostgreSQL 17 server transaction_timeout to 20 seconds before BEGIN, including lock acquisition, locked admission, all schema DDL and precommit semantic checks. At that bound the server terminates the session and rolls back any uncommitted schema transaction. No retry occurs. Locks may remain briefly while server rollback finishes; 20 seconds is a server transaction limit, not a hard end-to-end outage guarantee. On commit the adapter resets transaction_timeout before the index phase. Each concurrent index remains separately bounded by 2s lock / 60s statement and does not retain the four-table ACCESS EXCLUSIVE transaction locks. Fourteen index operations are not a promise of a 60-second whole rollout.

Baseline schema ACL is postgres UC and gymos_app U. Candidate schema ACL differs only by the intended gymos_refs_maint U grant, with the same schema owner. Both exact states are compared.
