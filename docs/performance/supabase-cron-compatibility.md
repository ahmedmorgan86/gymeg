# Supabase cron compatibility

This branch changes four scheduler blocks for fresh migration replay. They use named scheduling and deactivation in the same transaction. The helper is security invoker and cannot be executed by app or public roles. On environments without the cron schema the blocks skip installation. A failed deactivation aborts the migration transaction.

The local PGlite test runs the four actual scheduler blocks against stub SQL functions. It verifies that a role without SELECT on the job catalog can install all four, that repeat installation keeps IDs, and that every resulting row is inactive. The stubs have no scheduler or HTTP client. This is still pending replay against the exact pg_cron version in an isolated PostgreSQL environment.

The changes affect migration files already recorded by some installations. They are intended for fresh replay and must not be applied retroactively. The bundled host-scoped Supabase CA in main is outside this patch. A compatibility check for existing installations needs an independent migration plan and the permissions of the actual non-production extension owner.
