# Sender execution boundary, source-only

No job, environment, token, sender credential, schema, endpoint or external send is created by these files.

## Chosen direction to investigate

Keep the sender in a dedicated GitHub Actions job on the existing public repository's standard Linux runner, not in Vercel tenant-route runtime. Prefer workflow_dispatch on a single reviewed immutable tag/ref over repository_dispatch: the latter needs contents-write and is a wider code-change authority. A workflow dispatch still needs repository Actions-write authority, which is not scoped to one workflow. Therefore an app-held dispatch token is not a narrow single-purpose capability and must not be described as one.

A dispatch credential alone cannot expose sender environment secrets if that environment is restricted to the reviewed ref and workflow code is pinned, but Actions-write can trigger other workflows. A separate GitHub App installation restricted to this repository and Actions-write is a bounded account-level permission, not a workflow-only token. Creating that app or credential needs separate authority. Do not reuse the user's broad existing PAT in tenant runtime.

No prompt-delivery guarantee: GitHub jobs queue. A five-minute scheduled sweep is a best-effort recovery trigger, not primary prompt delivery. A dispatch attempt after committed outbox admission can reduce typical delay, but a missed dispatch needs a durable retry/sweep. Never dispatch inside the financial/commercial transaction or roll back the committed business action because GitHub is unavailable.

The smallest future account change for this direction is one sender-only protected environment plus one reviewed workflow and sender/dispatch credential custody. The sender's database login must be restricted to claim/finalize approved owner events and approved recipient tokens, with no tenant payload access. FCM account and token-decryption secret belong only in the sender job. The tenant process gets no sender-role password, FCM service account or decryption key.

This direction remains blocked on review of Actions-write exposure and allowed job latency. It is not ready for deployment. Main should describe any needed choice in terms of notification timeliness and account permission, not ask the owner to select an API.

## Safe worker entry contract

worker-entry.mjs is a fail-closed source-only boundary. It has no database, FCM, dispatch or network adapter. It cannot be used as an automatic sender. A real adapter must independently implement dedicated claims, final source/recipient checks, non-secret logs, retry/backoff, invalid-token retirement, no-recipient terminal state and at-least-once duplicate handling. Those semantics must use the approved two-event owner-only outbox, not the previous all-admin prototype.

## Current source guidance

https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10
https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
https://docs.github.com/en/actions/concepts/billing-and-usage
https://docs.github.com/en/actions/how-tos/troubleshoot-workflows

Live resource read: public ahmedmorgan86/gymeg, Actions enabled, two active workflows, zero environments. No changes were made.

## Owner-business orchestration candidate, local only

business-worker.mjs is dependency-injected source, not an executable worker. It has no database/network adapter, credentials, workflow or scheduler. The existing worker-entry still refuses execution. Eleven local tests cover whole-batch owner/event admission, bounded claims/recipient snapshots, duplicate rejection, stale lease and revoked-device gates, minimal bilingual content, non-secret aggregate reporting, retry/invalid/ambiguous transport outcomes, lost post-send fence, ledger exceptions and an explicit reclaim duplicate demonstration. These tests do not prove database permissions or actual transport/device delivery.

A future adapter must implement these operations with the dedicated restricted sender role, not the tenant role or the previous all-admin prototype:

- claim(owner,limit): atomically claim due approved two-kind business events for the independently bound owner, with bounded leases and claim generations. Snapshot the owner's eligible registered Support devices once, transactionally on first claim. A retry/reclaim must never expand that set. The current business-outbox schema has no lease/retry or per-device ledger columns/tables, so these are missing reviewed additive schema, not existing behavior.
- snapshotRecipients(event): return at most100 opaque recipient keys and owner ID, without token ciphertext or plaintext crossing this orchestration boundary. Returned records are the original snapshot, not a fresh enrollment fan-out.
- preSend(event,recipient): atomically verify current lease/generation, bound owner still eligible, current source event still actionable under reviewed business semantics, and that the same token is still enrolled and not revoked. Return eligible/ineligible/stale. It cannot eliminate revocation or lease expiry while the send is already in flight.
- send(event,recipient,message): resolve only that scoped registered token within the isolated adapter, decrypt inside that process and send the fixed minimal bilingual body with /platform target. Never log token, credential, order payload or raw transport error. FCM acceptance is not device receipt.
- finishRecipient(event,recipient,outcome): compare-and-set lease/generation and token identity before marking accepted, skipping revoked devices, recording ambiguous/retry outcomes or retiring an invalid original token. Never delete a replacement registration on a stale result. Retry/backoff and maximum attempts must be persisted, not held in process memory.
- finishEmpty(event) and finalize(event): fenced terminal/no-recipient or aggregate status decisions. Never blindly mark delivered. A failed CAS is a fence loss, not permission to retry immediately. Exceptions dispose the client and preserve uncertain outcome for reconciliation.

The injected contract cannot enforce any of those database/transport guarantees by itself. It also does not solve crash-after-send-before-ledger-commit or an old in-flight send after lease expiry. The local duplicate test deliberately proves possible duplicate external acceptance, not exactly once. Host/custody and timeliness choices in the preceding section remain unchanged and require their own authorization before installation.

## Restricted ledger preparation, disposable local PostgreSQL17

business-ledger-held.sql and ledger-local.mjs add a separate candidate delivery/device ledger without changing the existing admission table or tenant application. The candidate role is NOLOGIN/non-super/non-bypass and cannot read activation requests/tenant payload, modify recipient configuration, delete subscriptions or expose ledger rows to gymos_app. Owner-configured RLS confines outbox/devices to the single configured owner, not every admin. Eight local PostgreSQL checks apply the real current commercial/enrollment/admission source plus this candidate, then execute claim/snapshot under SET ROLE to that restricted role. They prove bounded first-claim snapshot, generation-fenced reclaim, no new-device expansion, replacement-ciphertext detection without deletion, owner revocation check, forged source/recipient refusal and runtime ledger denials. Local fixture is synthetic and its cluster is stopped/deleted in finally.

This is intentionally partial, not a runnable sender. No hosted adapter, login/password, token decryption, transport, workflow or job exists. NOLOGIN role was not changed to LOGIN; the local bootstrap superuser supplies SET ROLE for the test, so login custody/provider grant acceptance is not claimed. The module's enrollment-version read is one statement but separate from its lease check, not an atomic final pre-send gate. Source actionable-status check, final atomic checks, fenced finalize/retry/invalid-token-retirement operations, concurrent claimant tests, bounded claim transaction deadline and provider semantics remain missing. The claim transaction has1s lock/3s statement timeouts and bounded rows, not a guaranteed3s transaction limit. Current code does not wire these partial operations into runBatch. Do not infer sender readiness from successful ledger tests.


### Follow-up local concurrency and source-gate evidence

Eleven disposable PostgreSQL checks now pass. Two concurrent restricted-role claimers plus a following sweep claim eight unique events, at most4 per call. Concurrent first-ledger seeding can contend on the same first batch, so one initial caller may return no work; a later sweep progresses. This is not a promise of fair parallel throughput. More than100 devices aborts and rolls back both new lease and snapshot. Claim now sets server transaction_timeout5s and resets it, alongside1s lock/3s statement limits. Actual deadline termination still needs an injected test, not inferred from SHOW/reset.

The candidate now grants only activation_requests(id,status), with RLS limited to the configured owner's admitted outbox IDs. Tenant/user/amount/source payload columns remain denied and unadmitted IDs hidden. A single SQL statement observes current live lease, device ciphertext version, configured owner/admin eligibility and exact source status. Current proposal suppresses quote_requested after the request moves away from quote_requested and transfer_submitted after it moves away from pending_review. This mirrors existing admission's expected-status predicates, but whether already-obsolete alerts should be suppressed is a proposed product behavior, not a newly authorized business rule. It is local-only and needs review before installation.

These later checks supersede the earlier missing one-statement/source-gate note for this local candidate only. There is still no lock spanning external delivery, so revocation/expiry after the statement can race a send. Sender finalization/retry/retirement, provider/login custody and actual transport/device acceptance remain open. No executable wire-up exists.

### Fenced completion/retry candidate

Local ledger acceptance now15checks, plus the separate11orchestration tests. Local-only completion functions compare event, owner, lease ID/generation and unexpired sending state before updating the original snapshot row. Finalization locks/fences the lease and aggregates accepted versus pending/unknown rows. Ambiguous outcomes persist for a delayed retry, capped at5finalizations with exponential30s to1800s backoff; retries keep the original recipient snapshot. Tests reject old-lease results/finalization, retain an unknown result with delayed retry, accept a current fenced completion, preserve replacement enrollment and reach the failed cap. A6s injected insert-trigger delay hits the3s statement timeout and proves rollback/no automatic retry. This is statement-timeout evidence, not a separate5s transaction-timeout termination test.

No subscription retirement exists or privilege is granted, so invalid results can only terminate that event/device ledger row. Current candidate ledger accepts a transport result for the original snapshot after a replacement registration without altering that replacement. In a real adapter the exact snapshot token must be retained inside the in-flight operation; never re-resolve to a replacement after preSend. No ciphertext leaves the isolated adapter boundary. These rules and the module remain local preparation, not installed behavior.

The business admission outbox is unchanged and may still say pending while this separate candidate ledger records accepted or failed. Until an explicitly reviewed operator view/aggregation exists, neither table alone is a valid delivery dashboard. No app UI, production status contract, actual FCM response, device receipt or credential custody was exercised. runBatch is still not wired to these partial local operations.

### Operator count contract

operator-state.mjs has no database/UI entrypoint. Three unit tests separate business admitted count, awaiting-claim count, delivery-ledger states and transportAccepted from unverified deviceReceipt. Invalid inventory/status fails instead of silently calling a mismatch delivered. A real one-snapshot restricted-role query and operator UI are still missing; this source-only aggregate must not be presented as live status.

The restricted one-statement operator inventory is now tested on the disposable local database. One SELECT obtains admitted count plus ledger states under the same statement snapshot and owner-scoped RLS, then the pure aggregate reconciles12admitted events including1transportAccepted and1failed. This raises local ledger checks to16. It is synthetic database evidence, not a live dashboard/UI or device receipt. Invalid-token retirement remains unimplemented; no DELETE privilege has been added.

Version-safe invalid-result follow-up:17local ledger checks now include an original snapshot token that is replaced before the invalid result completes. Only the original event/device ledger row becomes invalid, the replacement ciphertext remains exact and a direct sender DELETE is denied. No subscription retirement privilege or function was added. This is safe per-event terminal handling, not global invalid-token retirement. Future events may re-snapshot an invalid registration unless a separately reviewed version-bound quarantine/retirement mechanism is added. The local test inventory now has13admitted events.

### Cross-event invalid-version quarantine and composed local worker

Current local acceptance is21checks. Without adding any privilege, future snapshots exclude an exact user+token-hash+ciphertext-version previously marked invalid in the existing device ledger. A new ciphertext version for the same hash is still eligible. The pre-send statement also checks this cross-event invalid history, so an already-snapshotted pending event can be suppressed if its exact version is invalidated before the final observation. Tests seed that intervening invalid version as a controlled fixture. This is retained-ledger quarantine, not deletion/global enrollment retirement. Deleting historical invalid ledger rows would lose quarantine; no retention/cleanup policy or cleanup was added. Lookup growth/index cost and ciphertext re-encryption semantics remain review gaps, since re-encrypting the same bad plaintext changes its version.

The actual runBatch orchestration is now wired to the restricted local claim/snapshot/pre-send/completion/finalization modules inside the disposable acceptance harness only, with one injected fake transport acceptance. The event ledger becomes accepted, payload remains fixed, and no external network adapter or credentials exist. Operator inventory now reconciles16synthetic admissions and2transport-accepted events. Device receipt stays unverified. No production worker entrypoint is enabled and no source-status suppression product rule is approved.


### Held transport classification preparation

transport-held.mjs has no default fetch, key, bearer resolver or token resolver. Six unit tests inject all dependencies: fixed minimal body, exact FCM endpoint, exact structured UNREGISTERED classification, bare404/auth/malformed ambiguity, network/decrypt failure, abort deadline and late resolver blocked from starting network. No credential or external network is used. It is not wired to the worker entrypoint.

Official error semantics checked24Nov2026: https://firebase.google.com/docs/cloud-messaging/error-codes . This exposed a concrete incompatibility to fix before integration: current ledger30s retry floor does not meet FCM429minimum1minute, and the current string outcome contract loses Retry-After needed for503. Do not wire this transport to that ledger until persisted retry-not-before and header handling are implemented and tested. Network ambiguity/timeout remains unknown, not proof of no send. Promise.race bounds returned wait, not hidden dependency work if an injected implementation ignores AbortSignal. No real token resolution/decryption/auth signer or custody is supplied.

Retry-contract correction now has22combined unit and22localPG checks. Transport returns a structured retry deadline for429/5xx, honors numeric or HTTP-date Retry-After, enforces at least60s for429, and refuses implausible beyond7day headers as unknown rather than scheduling an early retry. Worker forwards the deadline, ledger stores retry_not_before on the original device row, and fenced finalization takes the later of persisted deadline and exponential backoff, now with60s floor. LocalPG test proves a2minute deadline is not shortened. Added column exists only in held local candidate; no hosted alteration. This supersedes the earlier30s/retry-header gap for the local candidate, not actual transport acceptance.429/503 throttling still needs jitter and process-wide admission before install; no live load was used.
