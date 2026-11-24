# Current rollout admission, not a full-project clone gate

Read-only source evidence: 23 November 2026 20:48:09 Cairo, original project REVIEW_REQUIRED_ORIGINAL_PROJECT. No source DDL, writes, flags or deployment. Catalog session used REPEATABLE READ READ ONLY, 5s statement timeout and 1s lock timeout, then disconnected and removed its credential export.

## Current facts

- gym_entities has exactly the six original columns owner_id, collection, entity_id, position, branch, payload. 56 rows; heap 32,768 bytes; total relation 180,224 bytes. A small relation reduces expected rewrite work, but cannot bound lock waits or validate future growth.
- All 40 gymos tables are owned by postgres with RLS and FORCE enabled. There are 83 indexes across gymos, seven on gym_entities. The two general collection/branch/position indexes already exist. Do not rebuild or recreate them by replaying migration history.
- The only custom gymos role is gymos_app: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB. Provider postgres is non-superuser with BYPASSRLS and role creation rights. supabase_admin is the provider superuser. These exact distinctions matter to ownership and grant rehearsal.
- Existing six user triggers are card synchronization on entities, payment amount guard on states, staff synchronization, member portal identity guard, tenant branch-scope guard and immutable tenant identity. None of the demand counters / summary / owner-version / allocation-ref triggers exists yet.
- No active cron job and no other open transaction were observed at that instant. This is not a maintenance-window reservation.

## Minimal additive demand units still absent

The accompanying current-demand-object-diff.json is derived from current catalogs and source CREATE statements, not migration names alone. It does not claim semantic equality of existing function bodies or constraints.

| Unit | New state | Recovery dependency |
| --- | --- | --- |
| Counters | gym_entity_counters; four functions; entity/state trigger dependencies in source | Existing entity/state payload preserved; remove only new writer hooks if disabling, then exact recount before reactivation |
| Summary inputs + branch | three summary tables; eight unique function names; two summary indexes | Derived only, rebuild from payload; generation/dirty/readiness consistency must be checked |
| Owner version | gym_owner_version, gym_change_seq, five functions and writer triggers | Cache invalidation state, not recoverable by keeping a stale version; invalidate/rebuild if hooks fail |
| Canonical clock + strict keys | canonical_visit_clock, three stored entity columns, five indexes across the two source units | One entity-table rewrite; prechange schema/function metadata plus original payload archive are the relevant recovery inputs |
| Allocation refs | three refs tables, nine functions, four additional stored entity columns, seven indexes, gymos_refs_maint and writer/epoch triggers | New role/ACL/function ownership and exact refs readiness, not Supabase Auth service settings |
| Support business admission | two tables, five policies, one definer function, gymos_support_enqueue, three source-table column grants | Restore/revoke exact new role edges/grants/policies; existing commercial request and membership behavior must stay intact |

The scopes above are not one approved execution batch. Source also contains indexes and other migrations outside these units. An executor must produce the explicit selected dependency closure, preserving already-present objects. In particular, do not assume every old expression index is needed when a later strict-column reader supersedes it. That choice is still unreviewed.

## Free recovery path sufficient for these changes

A whole managed Auth / Google / SMTP / API / Storage settings clone is not required to roll back the additive demand schema or Support admission when those services and their settings are not changed. Requiring perfect managed-project recovery for this narrow rollout would be an unrelated blocker.

Use two complementary existing resources, with no new project and no spending:

1. The already-completed closed PostgreSQL 17.12 logical content restore establishes the ability to recover original payloads. Reuse its encrypted proof, not the customer restore target, which was deleted. Keep its explicit extension and provider-parity caveats.
2. Reconstruct the affected ownership/ACL boundary on a NEW disposable local no-egress PostgreSQL instance using synthetic rows only, or on the existing isolated synthetic provider for provider-specific grant behavior. The affected baseline is postgres-owned FORCE-RLS gymos tables and restricted gymos_app. Test as the non-super migration identity plus runtime, not as a superuser. Do not restore customer Auth service configuration or credentials for this check.
3. Before the exact additive rollout, preserve the live definitions, owners, ACLs, policies and triggers of only touched source objects. Compare the candidate script to this snapshot. The current metadata read has ownership/ACL/security attributes, but not complete function bodies and every constraint/default privilege; a targeted final capture of the selected closure remains necessary.
4. Apply the selected exact runner on synthetic baseline, test normal writes and forced failure / rollback, revoke temporary SET/schema CREATE rights, validate expected provider creator ADMIN edge, and reverse only newly introduced objects/hooks with readers off. Assert original synthetic payload bytes and original permissions unchanged. Do not DROP/recreate existing application tables or alter the runtime password.
5. For a transactionally failed DDL unit, rollback is the first recovery mechanism. For committed additive schema, turn dependent flags off and remove/revert only the reviewed hooks or use a forward repair. Full customer restore-overwrite is not the normal rollback mechanism.

Already available proof: isolated provider Support admission exercised non-super ownership transfer, wrong actor/status/recipient, rollback, commit, dedup and runtime denial; the final runner exit was 1 because of an incorrect creator-edge expectation, followed by independent correct catalog readback. Actual commercial HTTP established two committed synthetic events. These results must not be relabeled as an all-green end-to-end sender or as acceptance of the still-unbuilt combined demand runner.

The remaining necessary recovery capability is the exact selected demand hosted runner and its ACL/trigger reversal on the existing synthetic resource, not a paid clone and not managed Auth reconstruction. No new user decision is needed for private source review / local synthetic preparation. Production DDL and maintenance timing still require their own exact approval.

## Lock impact that matters

- Adding stored generated columns requires ACCESS EXCLUSIVE and a table rewrite. Current source separates three and four columns into two ALTERs. A combined seven-column ALTER can avoid a second rewrite, but that transformed executor has not been reviewed or run and must not be silently substituted.
- CREATE TRIGGER takes SHARE ROW EXCLUSIVE, which conflicts with ordinary writes. Trigger install / changes on gym_entities and gym_states need a bounded short transaction and lock-timeout abort. Small row count does not remove this risk.
- Ordinary CREATE INDEX blocks writes; the held hosted plan requires CREATE INDEX CONCURRENTLY outside a transaction. It performs more work and waits for old transactions. Verify indisvalid / indisready, handle failed invalid remnants explicitly, and do not use IF NOT EXISTS as proof of correct index definition.
- Allocation backfill obtains per-invoice FOR UPDATE locks. Summary/counter work changes derived rows and adds permanent write cost. Measure against concurrent synthetic writes under the actual restricted runtime.
- Current 56-row/32KiB source makes the previous 180k-row scratch rewrite timing irrelevant as a production estimate. Use lock timeout, current activity preflight and stop conditions, not a claimed millisecond guarantee.

Sources:
https://www.postgresql.org/docs/17/explicit-locking.html
https://www.postgresql.org/docs/17/sql-altertable.html
https://www.postgresql.org/docs/17/sql-createindex.html

## Separate sender host, using current resources

Live GitHub read: https://github.com/ahmedmorgan86/gymeg is public, Actions enabled with all actions permitted, two active workflows, zero configured environments. No sender workflow or isolated secret environment exists.

The most concrete no-new-host option is a dedicated GitHub Actions workflow on standard ubuntu-latest, with sender-only secrets exposed only to that job, no application build, no pull-request trigger, pinned dependencies, contents:read, one concurrency group and short timeout. The ephemeral job is separate from Vercel tenant-route runtime. This fits public-repository standard-runner free usage and creates no public HTTP service. It is a candidate, not deployed or approved credential custody.

Caveats: schedules run no faster than five minutes and can be delayed or dropped. A scheduled batch cannot promise prompt transactional delivery. repository_dispatch needs a separate scoped dispatch credential in the initiating process; a bounded workflow_dispatch can prove synthetic execution but is not automatic production delivery. Do not hide this latency/trigger decision. Environment secrets need a new environment and protected reviewed workflow because repository writers can otherwise change the workflow to read them. Actual permissions, protection and custody must be reviewed before installation.

Supabase Edge Functions on the existing project are another separate runtime with included free invocations, but secrets are project-level and default service credentials are broader than the proposed dedicated sender role. No secret-separated environment or deployed sender has been verified there. Do not install FCM credentials merely because the free quota exists.

Decision still open: accept five-minute-plus best-effort notification latency for a bounded scheduled sender, or choose a prompt event trigger with an independently reviewed scoped dispatch path. This is an execution design / product expectation choice, not permission to provision a host, add secrets, send notifications or spend.

Sources:
https://docs.github.com/en/actions/concepts/billing-and-usage
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
https://docs.github.com/en/actions/how-tos/troubleshoot-workflows
https://supabase.com/docs/guides/functions/secrets
https://supabase.com/docs/guides/functions/pricing
