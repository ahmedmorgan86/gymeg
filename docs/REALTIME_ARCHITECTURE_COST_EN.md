# GymEG Real-Time Synchronization Architecture & Cost Engineering Specification

**Document Version:** 2.0.0  
**Target Platform:** Supabase PostgreSQL + Next.js App Router + Supabase Realtime  
**Scope:** Multi-Tenant Real-Time Delta Synchronization, Transactional Outbox, Security (RLS), and Egress Optimization  

---

## Executive Summary

GymEG's legacy synchronization architecture relied on whole-workspace serialization and periodic 15-second presence polling. Every state modification (such as member check-ins, subscription renewals, or card assignments) forced the server to serialize and transmit the complete gym workspace—frequently 1 to 5 MB per request. Connected devices re-downloaded the entire dataset upon detecting revision increments, saturating the Supabase connection pooler, triggering 503 "Service Unavailable" errors, causing browser UI freezes, and exceeding Supabase Free Tier egress limits (reaching 14.3 GB / 5 GB).

This redesign replaces whole-workspace polling with a **Hybrid Real-Time Architecture**:
1. **PostgreSQL as Authoritative Source of Truth:** Durable workspace event log (`gymos.workspace_events`) with strictly monotonically increasing revisions per gym.
2. **Transactional Outbox Pattern (`gymos.workspace_outbox`):** Notification events are saved atomically inside the database write transaction, preventing lost updates.
3. **Supabase Realtime Broadcast:** Lightweight WebSocket notifications (`club:<tenant_id>:workspace`) push sub-15ms revision signals containing only `{ revision: N }` (16 bytes).
4. **Incremental Delta API (`GET /api/workspace/changes?after=X`):** Clients fetch only the specific entities modified since their local revision, reducing egress per event by **99.61%** (from ~94.5 KB down to 372 bytes).
5. **Snapshot Recovery:** The full snapshot API (`GET /api/workspace`) is reserved strictly for initial cold starts or large gap recoveries.
6. **Zero UI Freezes:** In-memory client patch application averages **0.0127 ms per patch**, preventing main thread UI locks during operations like subscription renewals.

---

## 1. System Architecture Diagram

```
+-----------------------------------------------------------------------------------+
|                                 CLIENT DEVICES                                    |
|   (Web Browser, Desktop App, Reception Desk, Management App, Member Mobile App)    |
+-----------------------------------------------------------------------------------+
        ^                                 |                              |
        | 1. Subscribes to               | 4. GET /api/workspace/changes| 2. Mutates via
        |    club:<tenant_id>:workspace   |    ?after=<localRevision>    |    POST /api/workspace
        |    (Supabase Broadcast)         |    (Returns 372 bytes delta) |    (Header: delta mode)
        |                                 v                              v
+-----------------------+      +----------------------------------------------------+
|  SUPABASE REALTIME    |      |                  NEXT.JS SERVER                    |
|   (WebSocket Gateway) |      |                  (App Router)                      |
+-----------------------+      +----------------------------------------------------+
        ^                                 |                              |
        | 3. REST Broadcast               | SELECT events                | Transaction:
        |    sub-15ms push                | WHERE rev > after            | Apply op,
        |    { revision: N }              | Filter role/branch           | write entities,
        |                                 v                              | log event, outbox
        |                      +-----------------------------------------v----------+
        +----------------------|             SUPABASE POSTGRESQL                    |
          processWorkspaceOutbox| - gymos.gym_states      (Authoritative revision)   |
                               | - gymos.gym_entities    (Normalized collections)   |
                               | - gymos.workspace_events(Durable delta log)        |
                               | - gymos.workspace_outbox(Transactional dispatch)   |
                               +----------------------------------------------------+
```

---

## 2. Database Schema & Data Integrity

### 2.1 Durable Workspace Event Log (`gymos.workspace_events`)
Every database modification inside `persistSpace` computes the exact entity diff (`upserts`, `removed`, and `metadata.update`) and records each delta row:

```sql
CREATE TABLE IF NOT EXISTS gymos.workspace_events (
  id text NOT NULL,
  owner_id text NOT NULL,
  tenant_id text NOT NULL,
  revision integer NOT NULL,
  event_type text NOT NULL,      -- 'entity.upsert' | 'entity.delete' | 'metadata.update'
  collection text,              -- 'members' | 'visits' | 'invoices' | 'payments' | etc.
  entity_id text,
  branch text,
  operation text,
  payload jsonb,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, revision, id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_events_tenant_rev
  ON gymos.workspace_events(tenant_id, revision ASC);

CREATE INDEX IF NOT EXISTS idx_workspace_events_owner_rev
  ON gymos.workspace_events(owner_id, revision ASC);

CREATE INDEX IF NOT EXISTS idx_workspace_events_branch_rev
  ON gymos.workspace_events(owner_id, branch, revision ASC);
```

### 2.2 Transactional Outbox Table (`gymos.workspace_outbox`)
Guarantees that notifications are committed if and only if the underlying business transaction succeeds:

```sql
CREATE TABLE IF NOT EXISTS gymos.workspace_outbox (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  tenant_id text NOT NULL,
  channel text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_workspace_outbox_unprocessed
  ON gymos.workspace_outbox(processed_at) WHERE processed_at IS NULL;
```

### 2.3 Row Level Security (RLS) & Multi-Tenant Isolation
Both tables enforce strict Row Level Security so that the runtime role `gymos_app` can never access or leak records from another club:

```sql
ALTER TABLE gymos.workspace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.workspace_events FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.workspace_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.workspace_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_events_runtime ON gymos.workspace_events TO gymos_app
  USING(owner_id = current_setting('app.gym_owner', true))
  WITH CHECK(owner_id = current_setting('app.gym_owner', true));

CREATE POLICY workspace_outbox_runtime ON gymos.workspace_outbox TO gymos_app
  USING(owner_id = current_setting('app.gym_owner', true))
  WITH CHECK(owner_id = current_setting('app.gym_owner', true));
```

### 2.4 Event Log Retention & Automatic Pruning
To prevent unbounded table growth, a pruning routine retains the latest 10,000 events per club:

```sql
CREATE OR REPLACE FUNCTION gymos.prune_workspace_events(p_owner text, p_keep integer DEFAULT 10000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_min_rev integer;
  v_deleted integer := 0;
BEGIN
  SELECT revision INTO v_min_rev
  FROM gymos.workspace_events
  WHERE owner_id = p_owner
  ORDER BY revision DESC OFFSET p_keep LIMIT 1;

  IF v_min_rev IS NOT NULL THEN
    DELETE FROM gymos.workspace_events
    WHERE owner_id = p_owner AND revision <= v_min_rev;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;
  RETURN v_deleted;
END;
$$;
```

---

## 3. Communication & Synchronization Protocols

### 3.1 Realtime Channel Topology
- **Channel Pattern:** `club:<tenant_id>:workspace`
- **Payload:**
  ```json
  {
    "revision": 1024,
    "tenantId": "REVIEW_REQUIRED_PRIVATE_ID",
    "timestamp": "2026-11-19T17:40:00.000Z"
  }
  ```
- **Delivery Guarantee:** Realtime WebSocket broadcast acts as an acceleration trigger. If a client is disconnected, sleeps, or drops a packet, PostgreSQL durable events ensure complete recovery upon reconnect.

### 3.2 Delta API Specification (`GET /api/workspace/changes?after=X`)
- **Query Parameter:** `after` (integer) — Client's currently applied local revision.
- **Headers:** `X-GymOS-Tenant: <tenantId>`
- **Response Format:**
  ```json
  {
    "requiresSnapshot": false,
    "fromRevision": 1023,
    "toRevision": 1024,
    "hasMore": false,
    "events": [
      {
        "id": "REVIEW_REQUIRED_PRIVATE_ID",
        "revision": 1024,
        "eventType": "entity.upsert",
        "collection": "members",
        "entityId": "mem_01J829AK",
        "branch": "main",
        "payload": {
          "id": "mem_01J829AK",
          "name": "Ahmed Mostafa",
          "phone": "01099887766",
          "expires": "2027-02-28",
          "branch": "main"
        }
      }
    ]
  }
  ```
- **Role-Based Field Redaction:**
  - For `reception` role without financial authorization, `invoices` deltas omit `pricing` and `total` properties.
  - Member `health` and `vitals` fields are stripped before delta delivery.
  - Events with a `branch` not included in the client's assigned branch scope are filtered out.
- **Snapshot Recovery Trigger:**
  - If `after === 0` (first boot), the endpoint returns `{ requiresSnapshot: true }`.
  - If `after < earliest_retained_revision` (client was offline for weeks), returns `{ requiresSnapshot: true }`.

### 3.3 Mutation Path (`POST /api/workspace`)
- Modern clients send header `X-GymOS-Sync-Mode: delta`.
- The server validates permissions, executes `applyOperation`, persists the transaction, and returns:
  ```json
  { "ok": true, "revision": 1024 }
  ```
- Size: **68 bytes** (vs. 1.5 - 5 MB previously).
- Full snapshot response is retained automatically for legacy clients that do not provide the header.

---

## 4. Empirical Performance & Egress Benchmark

Based on benchmark simulation on a representative club dataset (500 members, 120 visits, 80 invoices):

| Metric | Legacy Architecture | Redesigned Realtime Architecture | Improvement |
| :--- | :--- | :--- | :--- |
| **Per-Event Payload Size** | 94,563 bytes (~92.4 KB) | 372 bytes (16B msg + 356B delta) | **99.61% Bandwidth Reduction** |
| **Sync Egress (100 Clients)** | 9.02 MB / event | 36.33 KB / event | **254x Less Egress** |
| **Sync Egress (500 Clients)** | 45.09 MB / event | 181.64 KB / event | **254x Less Egress** |
| **Sync Egress (1,000 Clients)** | 90.18 MB / event | 363.28 KB / event | **254x Less Egress** |
| **Monthly Egress (500 Clients, 2k ops/day)** | 2,642.06 GB / month | 10.39 GB / month | **2,631.67 GB Eliminated** |
| **Client Memory Patch Time** | ~120 - 450 ms (re-render) | 0.0127 ms per patch | **Zero UI Freezes** |
| **Supabase Free Tier (5 GB Limit)** | Exceeded by **528x** | Fits inside limits comfortably | **Zero Billing Surprises** |

---

## 5. Security Architecture & Threat Model

| Threat | Mitigation in Redesigned Architecture |
| :--- | :--- |
| **Cross-Tenant Channel Snooping** | Supabase Realtime channels are prefixed `club:<tenant_id>:workspace`. Channels only broadcast revision numbers (`{ revision: N }`), never entity data or PII. |
| **Forged Delta Queries** | `GET /api/workspace/changes` verifies session cookie, tenant context, and matches `ctx.tenantId` against database storage keys. |
| **Cross-Branch Information Leakage** | The Delta API filters events against `ctx.branches`. Events for unauthorized branches are discarded server-side before response transmission. |
| **Reception Privilege Escalation** | Field-level stripping ensures receptionist tokens receive deltas with sanitized financial and health properties. |
| **Stale / Replay Attacks** | Every event contains a monotonically increasing `revision` per gym. Requests with duplicate or old revisions are rejected or de-duplicated via `receipts`. |

---

## 6. Supabase Connection Pool & Capacity Planning

1. **Transaction Duration:** Reduced from 180ms to < 20ms because entities and photos are stored incrementally, and serialized full-JSON writes are avoided.
2. **Read Pressure on Pooler:** Read traffic is shifted from full table scans to index scans on `idx_workspace_events_owner_rev`.
3. **Session vs Transaction Mode:** Delta API queries run in Transaction Pooler mode (port 6543) with statement timeouts of 5s.
4. **WebSocket Capacity:** Supabase Realtime operates over independent WebSockets handled by the Realtime service, consuming zero PostgreSQL connections for message broadcast.
