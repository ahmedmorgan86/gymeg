# Allocation refs: restore and trigger-bypass import runbook (held, review only)

Scope: migration 20261122030000. Applies to any SUPPORTED operation that writes `gym_entities` or `gym_states` while a refs maintenance trigger would not fire or would not be trusted.
Not covered, excluded as corruption: arbitrary DBA edits of the refs, odd, state or derived tables, and ad hoc `DISABLE TRIGGER` use outside this runbook.

Normal application writes (persistSpace, restore and import through it, owner delete, TRUNCATE) and `session_replication_role=replica` writers need NO runbook: the seven triggers are ENABLE ALWAYS, so refs are kept exact, or the owner is tombstoned, in the same transaction.

Runbook for a deliberate trigger-bypass import (pg_restore --disable-triggers, or ALTER TABLE ... DISABLE TRIGGER for a bulk load):
1. BEFORE the import: `node scripts/refs-ready.mjs --invalidate OWNER...` (migration role). Exit 0 and status `invalidated` for every owner is required. Any other status means the tombstone is not confirmed: do not start the import.
   From this moment every refs reader (Reports refs reader, member-credit helper) refuses with refs-not-ready.
2. Run the import. Afterwards re-enable the triggers as `ENABLE ALWAYS` (not plain ENABLE): `ALTER TABLE gymos.gym_entities ENABLE ALWAYS TRIGGER invoice_allocation_refs_ins` (and _upd, _del, _trunc), and `ALTER TABLE gymos.gym_states ENABLE ALWAYS TRIGGER invoice_allocation_refs_epoch_upd` (and _epoch_del, _epoch_trunc). The reader refuses while any trigger is not ALWAYS-enabled.
3. AFTER: `node scripts/refs-ready.mjs OWNER...` (rebuild in bounded batches, then complete bound to the captured generation). Status `ready` is the only success. `outcome-unknown` requires reconciling the readiness flag and generation before any claim.
The owner stays unready, and readers keep refusing, until step 3 returns `ready`. complete() refuses (returns false) while any refs are stale. tests/refs-ready.pg.mjs section 8 exercises exactly this sequence on PG16.
A trigger-bypass import done WITHOUT step 1 is outside the supported path: the refs can be stale while the owner still reads as ready.
