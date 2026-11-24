# Provider role correction, local acceptance only

Candidate base: 97aaf3dca630b8fd147d7d15fa6e588dfbd55df8. This work does not alter that display-preview candidate, push, deploy, capture production backups, create cloud projects, or authorize production SQL.

## Change

The allocation-ref migration now allows only the provider bootstrap-superuser's creator ADMIN membership to postgres, with INHERIT/SET both false. NULL/missing provider roles do not create an exception to membership validation. Other attributes, dependencies and ACL checks remain fail-closed.

All four trigger-function ownership transfers run at the end in one atomic DO block with temporary schema CREATE and postgres SET-without-INHERIT. Both temporary grants are revoked and final cleanup is asserted. An injected failure halfway through the block leaves no temporary grant. Runtime gymos_app receives no maintenance membership or new write privilege. No function is made postgres-owned as a workaround.

## Reproduction environment

Disposable local PostgreSQL 17.5 cluster, port 55434, trust authentication on localhost only. Bootstrap superuser named supabase_admin; migration role postgres LOGIN NOSUPERUSER BYPASSRLS CREATEROLE CREATEDB; runtime gymos_app NOSUPERUSER NOBYPASSRLS. Provider-shaped postgres SET/INHERIT-false membership in gymos_app is supplied by the bootstrap superuser for runtime-role test switching. Database rehearsal_roles owned by postgres. This is not a full Supabase clone: extension functions, vault, cron and net use existing test stubs, not production services.

Explicit local-only scripts:
- provider-roles-local.mjs: fresh base + all 50 migration files under restricted migration role.
- provider-functional-local.rehearsal.mjs: existing five allocation-ref behavior tests over real PostgreSQL instead of PGlite.
- provider-validator-local.rehearsal.mjs: original unsafe-role tests plus altered provider membership options; administrator sets up hostile fixtures inside rolled-back transactions, then postgres runs validation.
- provider-cleanup-local.mjs: exact residual membership, four function owners/search_path, FORCE RLS, runtime denials, injected transfer failure atomicity.
- Existing refs-complete-race.pg.mjs: controlled restore/rebuild/complete interleavings and 40 stress iterations, migration connection is restricted postgres.

Scripts intentionally use fixed disposable localhost URLs and are not part of the regular unit suite. They must never be repointed at production.

## Local results

All 50 migration files applied as non-superuser postgres. Five behavior tests passed, unsafe-role checks passed, cleanup/failure-atomicity passed, restore race passed. Focused existing unit tests for allocation refs, member credit refs and reports refs: 19/19, no skips.

## Remaining rollout gates

No provider rehearsal or live execution is claimed. Actual provider extension/ACL behavior and current target catalogs still need verification on an approved empty isolated environment with synthetic data. Production hold remains. Before any authorized production change, require a recoverable encrypted logical backup with schema/roles/data coverage and a successful isolated restore rehearsal. Do not treat business JSON export as whole-database recovery; do not restore over customer data as an ordinary rollback. Scope and timing of backup capture, rehearsal resource creation, production DDL, locking/rewrite window and any rollback writes require their own authority. Source payload remains authoritative; leave dependent readers disabled/unready until exact checks pass. Provider reference: https://supabase.com/kb/troubleshooting/cant-revoke-a-role-membership-granted-by-supabase_admin-d08922

## Actual isolated Supabase acceptance, November 23 2026

New Free Nano project gymeg-synthetic-rehearsal, REVIEW_REQUIRED_SYNTHETIC_PROJECT, PostgreSQL17.12. No existing project copied, no customer data, no GitHub integration. Fresh catalogs had no gymos schema or application roles and zero auth.users. Actual postgres NOSUPERUSER/BYPASSRLS.

Provider found two additional old source incompatibilities: direct UPDATE cron.job in messaging and attendance migrations. Replaced each with supported cron.alter_job(job_id := jobid, active := false). No broader table grant. Transactional bootstrap then committed all50 migration files plus base,49 tables. All four cron definitions explicitly inactive before commit; no external worker job ran. Earlier failed transaction left no application schema/roles by follow-up catalogs.

Actual provider functional5/5, exact residual creator-admin membership, four pinned maintenance function owners, runtime no derived writes/membership, temporary-grant cleanup and injected-failure atomicity, plus controlled restore race40iterations all passed. Final acceptance used sslmode=verify-full and provider CA obtained from new project's Database Settings. Preliminary encrypted-only tests were superseded. A repeat-test fixture pollution failure was fixed by emptying the synthetic entity fixture at start, then all five passed again with verified TLS. No production migration, backup capture, backend environment changes or whole-release acceptance implied. Only synthetic fixtures remain.

Provider cron reference: https://supabase.com/docs/guides/cron/quickstart
Rehearsal project: https://supabase.com/dashboard/project/REVIEW_REQUIRED_SYNTHETIC_PROJECT
