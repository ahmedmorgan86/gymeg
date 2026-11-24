# Allocation refs: supported contract and excluded imports (held, review only)

Migration 20261122030000. The refs triggers are plain (origin-role) triggers, like the existing owner-version triggers.

SUPPORTED: ordinary application writes in an origin-role session: persistSpace upserts, removals, restore and import through it, owner delete, TRUNCATE. The row triggers keep the refs exact, or the epoch triggers tombstone the owner, in the same transaction as the write. No runbook applies.

EXCLUDED while any reader is live: session_replication_role=replica and logical-replication apply, ALTER TABLE ... DISABLE TRIGGER (pg_restore --disable-triggers) and any other trigger-bypass import, and arbitrary DBA edits of the refs, odd, state or derived tables.
Reason: such writes skip the refs triggers AND the owner-version triggers (origin-only), so snapshot rechecks, caches, summaries and counters can stay stale indefinitely. Tombstoning the refs alone does not repair that, and enabling the refs triggers with ENABLE ALWAYS does not either (that scope change was reverted).
The refs readers refuse a replica-role session and any disabled refs trigger, but cannot detect an earlier disable/write/re-enable sequence or replica-role import.

If such an import is ever needed it is a separate trusted operation, owned by whoever owns the version/epoch machinery: readers disabled externally (flags off, sessions quiesced), the import, a trusted new epoch/version for every affected owner, rebuild of every derived structure, verification (including `node scripts/refs-ready.mjs OWNER...`, whose only success status is `ready`), then reopen. `scripts/refs-ready.mjs --invalidate OWNER...` writes the refs tombstone only. tests/refs-ready.pg.mjs section 8 shows the refs mechanics (tombstone, stale refs refused by complete(), rebuild and complete); it is not a claim that the whole import is supported.
