# Recovery and rollout dependencies

Engineering review artifact, 23 November 2026. HELD. This is not production execution approval.

## Current decision

The encrypted logical recovery set has passed a contained database-content restore. It does not establish that the managed project can be recovered with equivalent permissions, login behavior and service settings. Therefore the current production schema, roles, application flags and deployment stay unchanged.

Scope correction after the 20:48 read-only catalog: see current-rollout-admission-20261123.md. Additive demand / Support units need affected gymos ownership, ACL and trigger recovery, not unrelated managed Auth / Google / SMTP settings reconstruction when those services are unchanged. The broader service-recovery list below applies only to a whole-project disaster recovery claim or a rollout that changes those services. A binary provider clone is not a substitute under the present constraints.

## Why the obvious clone path is not currently usable

Supabase's current restore-to-new-project documentation says that the feature requires a paid plan and physical backups, creates a new billable project, and starts external-operation extensions as soon as the restore completes. It says those jobs cannot be excluded or paused before that restore. The source has cron and network extensions, so this path conflicts with both the stop-on-cost and no-egress rehearsal requirements. No clone, plan upgrade or billable project has been requested or created by this work.

The documented manual logical restore path does not transfer the encryption root key. The completed rehearsal deliberately addressed logical Vault values by reencrypting them under a fresh target root. This proves recovery of those three values, not portability of every encrypted field or provider-managed key.

Sources checked 23 November 2026:
- https://supabase.com/docs/guides/platform/clone-project
- https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
- https://supabase.com/docs/guides/database/vault
- https://www.postgresql.org/docs/17/app-pgrestore.html

## Completed evidence and its limits

| Evidence | Proven | Not proven |
| --- | --- | --- |
| Read-only source capture | Full PostgreSQL 17.12 custom archive, one consistent snapshot, 85 table counts, no source writes | Future source changes after the snapshot |
| Private off-machine recovery set | Encrypted database, roles without password hashes, manifest, logical Vault values and restore proof in owner-only Drive folder; ciphertext download hashes and authenticated decryption checked | Ongoing backup schedule or automatic disaster recovery |
| Empty, closed restore | Strict pg_restore exit 0 with real extensions, 85 counts, 81 COPY tables / 779 rows exact canonical row-byte parity | Provider ownership / ACL semantics, custom-role login credentials, managed service behavior |
| Vault recovery | Three logical values reencrypted under a new target root and checked | Original root migration, unread encrypted columns outside these logical records |
| RLS | All 40 gymos tables retained enabled and FORCE flags | Correct restored owners, grants, SECURITY DEFINER privileges and runtime isolation as an equivalent managed project |
| Cleanup | All customer-content local restore targets, decrypted dumps and temporary keys removed | A retained managed recovery environment |

Full private evidence destination:
[private recovery location omitted]

## Remaining provider recovery acceptance

1. Establish a new empty target that cannot send network requests or start jobs before data is loaded. Use a supported provider path or a provider-supported containment guarantee. Do not attach the application, customer clients, mail, push, OAuth callbacks or external integration credentials.
2. Recreate application roles and ownership with least privilege. Review the archive's grants before applying them. Do not restore global role passwords, logins, superuser or BYPASSRLS rights blindly. The completed local NOLOGIN/no-owner/no-acl restore intentionally did not test these effects.
3. Verify table / sequence / schema ACLs, ownership, function security mode, pinned search paths and default privileges. Run the application as the restricted runtime role, never as postgres. Test cross-tenant and revoked-member reads, writes, and SECURITY DEFINER calls.
4. Prove a synthetic restored Auth login using a deliberately isolated service configuration, without emails, Google callback changes or exposing original customer accounts. Database auth row parity alone is not a service login test.
5. Inventory and review Auth settings / keys, storage settings / objects, functions, Realtime, database settings, integrations and project settings separately. The observed capture contained zero Storage objects, which is a snapshot fact, not a permanent assumption.
6. Keep schedulers and network extensions disabled. Install only needed synthetic credentials, explicitly bind a synthetic recipient, and inspect effective cron and worker state. A configuration string is not proof of containment.
7. Compare restored content, permissions and supported service behavior, then delete the target within the authorized maximum retention. Retain encrypted originals until the owner authorizes their deletion.

If no provider-supported path can meet containment and cost constraints, record that as a blocker. Do not silently replace it with a paid binary clone or restore into an existing populated project.

## Production rollout dependencies, in order

The current catalog-specific admission in current-rollout-admission-20261123.md narrows the dependencies below for the selected additive units. It takes precedence over treating all managed-project recovery gaps as prerequisites for every code change.

### A. Source and artifact reconciliation
- Pin reviewed app source and SQL independently. Test-only and rehearsal-only commits must not be confused with production application behavior.
- Current reception notice correction has a successful full build and explicit granted/ungranted HTTP + Arabic/English profile proof. It changes copy, not permissions.
- Previous broad unit completion was 180 passing files / 2 public-APK provenance failure files, not all green. Later targeted notice test is additional evidence, not a replay of the broad suite. Broad-batch execution used Node 22.23.5. A later official Node 24.22.3 Linux distribution passed checksum verification, the full Next production build, and 13 targeted proxy / reception-notice / Windows metadata tests. This is bounded compatibility evidence, not a Node 24 replay of the broad suite.
- Keep all three Android source/artifact/signature checks intact. Do not edit expected hashes or public metadata to make old artifacts pass.
- Private unsigned Windows crossbuild is compile evidence only. Native install, signing/update, Google, push, hardware and backup/runtime remain separate acceptance.

### B. Exact production catalog difference
- Obtain approved read-only live catalog evidence immediately before proposing the production effect set. Old catalog data and migration filenames are leads, not current facts.
- Produce an object-by-object delta for existing source state. Do not replay the synthetic bootstrap or the entire historical migration chain.
- Classify each ALTER, generated-column rewrite, index, grant, role, policy, trigger, function, backfill and flag. Name lock level, expected lock wait, write amplification, WAL / storage effect, stop condition and forward-repair path.
- Rehearse the exact hosted runner with non-superuser provider semantics and concurrent traffic. The local superuser test previously missed GRANT-after-ownership behavior. The isolated provider corrected that ordering, but its SQL is not thereby approved for production.

### C. Demand schema and data readiness
- See hosted-schema-plan.md for the held rewrite/concurrent-index split. Its warm local timings do not predict production latency.
- Keep readers off until columns / indexes / triggers are verified. Validate concurrent index completion and any invalid leftovers through supported maintenance actions.
- Backfill refs / counters / summaries with generation and dirty-row protections, compare exact financial oracles and branch privacy, then enable only the approved per-route flags.
- Trigger-bypass restores/imports require all readers off, quiescence, trusted new epochs / owner versions, complete derived-state rebuild and verification. Refs tombstoning alone is insufficient. See refs-restore-runbook.md.

### D. Support notifications
- Approved business semantics are only quote request and submitted transfer needing review, owner-only registered Support devices, minimal bilingual copy and /platform click target.
- Existing isolated HTTP proof established exactly two committed outbox events for a synthetic recipient. No sender or real delivery occurred.
- A separate restricted sender process, credential custody, usable already-approved host and intended owner binding remain required. Do not put sender credentials into tenant-route runtime or reuse the all-admin prototype.
- Preserve at-least-once semantics, send/mark and in-flight-lease duplicate caveats. Device receipt / background / click proof cannot be inferred from queue rows or FCM acceptance.

### E. Client, language and owner acceptance
- Desktop web owner / branch-manager / reception scoped HTTP and selected Arabic/English member-console screens are proven; the rest of the feature map still requires real journeys.
- Three Android apps, actual Windows, iPhone Safari and mobile web require their own runtime acceptance. Desktop Chrome is not a substitute.
- Google callback, camera / cards, member phone+PIN, notifications, backup / restore, devices / attendance, audio / speech, finance, team permissions and every requested bilingual flow remain on the release scope.
- Present the exact accepted artifact set and production effect list for the required owner decision. No deployment, production DDL/roles/flags, new public host, real outbound delivery, spending or customer overwrite follows from this document.

## Rollback is not routine restore-overwrite

Prefer keeping readers off, stopping the new worker, reverting the application/flags, and applying a reviewed forward repair. Dropping new generated columns and indexes can itself lock or destroy derived state and needs a reviewed exact effect set. A database archive is not permission to replace current customer data. Any restore over a populated target is a separate consequential decision, with an explicit recovery point and data-loss window.
