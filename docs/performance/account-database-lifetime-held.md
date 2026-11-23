# Scoped member-account database lifetime, held

GYMOS_MEMBER_ACCOUNT_READS is still default OFF. This source change is not an activation or rollout approval. The new helper is used only by that endpoint and by an optional deadline parameter on codeMemberIdentity. Other callers keep the original authentication and writer behavior.

## Counterexample

The earlier account helper's4-second clock began after identity and license checks. In a separate disposable local PostgreSQL14 database, six native authenticated HTTP requests were issued while the member session table was locked for5.25seconds. Five runtime connections waited on that lock and one request queued in the app pool. All six returned200in5.31-5.38seconds. Per-statement/detail caps did not bound route acquisition or authentication.

## Candidate repair

The endpoint now starts one absolute4-second database budget at route entry. Session identity, license lookup and detail read use the same deadline. Every transaction is BEGIN READ ONLY. Source identity, mandatory PIN change, license and branch/member pinning are unchanged.

read-transaction.ts bounds pending acquisitions to10, including expired acquisitions that the pool has not delivered yet. This is an explicit admission choice, not a measured capacity claim. A pool lease delivered after expiry is released without BEGIN, scope setup or callback execution. A callback cannot issue SQL after the deadline. SQL gets a remaining-budget statement timeout, at most2seconds, plus a local timer. When the timer expires during SQL, the connection is destroyed so hidden SQL cannot continue on a reusable lease. Ordinary statement cancellation rolls back before safe reuse. Failed BEGIN, failed cleanup or expired/unknown transaction state destroys the connection. The helper does not change the global pool or writer retry policy.

Tests cover expired acquisition, late lease release, admission saturation, READ ONLY, SQL cancellation and rollback/reuse, in-flight deadline destruction, late callback refusal, failed rollback and failed BEGIN. An application timeout response without transaction cleanup is not counted as success.

## Native local result

Five unconverted portal requests were deliberately left holding the five native connections on the local session lock. A sixth, queued account request refused with503at about4.04seconds. After the5.25-second lock was released, its late lease was released safely and a new authenticated account request returned200. No idle-in-transaction or aborted transaction connections remained. Portal requests still took about5.40seconds, explicitly outside this scoped repair.

This is local PostgreSQL14/Next production-server evidence with actual current_user=gymos_app, NOBYPASSRLS and no auth/database mocks. It is not hosted PostgreSQL16 acceptance. Local fixture sessions, lock and server children were cleaned up. No remote target, account grant, notification or deployment changed.

Unconverted portal and other fallback routes, CPU/JSON work, event-loop delay, network delivery and response serialization remain outside this database-lifetime claim. The existing driver can retain an expired queued connect promise until its own connection timeout; admission bounds how many of these this helper can create, and each late lease is released without work. Shared allocation-reference integrity and full-owner financial parity remain separate held gates.
