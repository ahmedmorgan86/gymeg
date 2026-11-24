# GymEG Real-Time Synchronization Zero-Downtime Migration Runbook

**Document Version:** 1.0.0  
**Target Environment:** Staging & Production (Supabase PostgreSQL + Next.js App Service)  
**Author:** Software Architecture & Infrastructure Engineering Team  

---

## 1. Migration Strategy & Preconditions

The Real-Time Delta Synchronization upgrade is designed for **100% zero-downtime execution** using additive schema changes and backwards-compatible APIs.

### 1.1 Non-Breaking Backward Compatibility
- Existing endpoints (`GET /api/workspace` and `POST /api/workspace`) remain fully functional.
- The server detects whether a client supports Delta mode via the `X-GymOS-Sync-Mode: delta` header.
- Older client sessions, mobile apps, or desktop clients that have not refreshed will continue receiving full snapshots without disruption.
- Newly connected clients automatically switch to Supabase Realtime channels and incremental delta polling.

---

## 2. Preflight Checklist

Run these checks before executing the migration in production:

1. **Verify Database Connectivity:**
   ```bash
   psql "$DATABASE_URL" -c "SELECT current_database(), current_user, version();"
   ```
2. **Verify Schema & Role Existence:**
   ```sql
   SELECT rolname FROM pg_roles WHERE rolname IN ('gymos_app', 'anon', 'authenticated');
   SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'gymos';
   ```
3. **Verify Adequate Storage:**
   Ensure at least 500 MB of free storage is available in PostgreSQL for new indexes and initial event logging.

---

## 3. Database Migration Steps

Execute migration file `supabase/migrations/20261120000000_workspace_events_and_outbox.sql`:

```bash
psql "$DATABASE_URL" -f supabase/migrations/20261120000000_workspace_events_and_outbox.sql
```

### 3.1 Migration Verification Queries

Run the following validation queries in PostgreSQL:

#### Check 1: Verify Table Creation and Primary Keys
```sql
SELECT table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_schema = 'gymos' 
  AND table_name IN ('workspace_events', 'workspace_outbox')
ORDER BY table_name, ordinal_position;
```
*Expected Result:* Both `workspace_events` and `workspace_outbox` columns are listed with expected data types (`text`, `integer`, `jsonb`, `timestamptz`).

#### Check 2: Verify Indexes
```sql
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE schemaname = 'gymos' 
  AND tablename IN ('workspace_events', 'workspace_outbox');
```
*Expected Result:* Indexes `idx_workspace_events_tenant_rev`, `idx_workspace_events_owner_rev`, `idx_workspace_events_branch_rev`, and `idx_workspace_outbox_unprocessed` are present.

#### Check 3: Verify RLS Policies
```sql
SELECT tablename, policyname, roles, cmd, qual 
FROM pg_policies 
WHERE schemaname = 'gymos' 
  AND tablename IN ('workspace_events', 'workspace_outbox');
```
*Expected Result:* Both tables have `ROW LEVEL SECURITY` active with policies granting access strictly to `gymos_app` scoped to `current_setting('app.gym_owner', true)`.

---

## 4. Application Deployment Steps

1. **Environment Variables:**
   Confirm the following environment variables are set in production (e.g., in Vercel or your hosting platform):
   - `NEXT_PUBLIC_SUPABASE_URL`: Your Supabase HTTPS URL (e.g. `https://<id>.supabase.co`).
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon/publishable key.
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase secret service-role key (used for server-to-server broadcast REST API).

2. **Deploy Application Code:**
   Deploy the updated Next.js application containing:
   - `app/api/workspace/changes/route.ts` (Delta API)
   - `app/api/workspace/route.ts` (Optimized mutation handler)
   - `app/lib/entity-store.ts` (Transactional event & outbox persistence)
   - `app/lib/realtime-broadcast.ts` (Outbox processor & broadcast sender)
   - `app/lib/workspace-sync.ts` (Client sync manager)
   - `app/workspace.tsx` (Client integration)

3. **Post-Deployment Verification:**
   - Open a club workspace in two separate browser windows (or Incognito).
   - In Window 1, check in a member or update a member note.
   - Observe Window 2: the update should appear in real time without refreshing and without full page loading.
   - Check the Network tab in DevTools: verify that the response to `/api/workspace` was `< 1 KB` and the subsequent `/api/workspace/changes` request returned only the modified entity.

---

## 5. Operations & Health Monitoring

Run these queries periodically or configure them into your monitoring dashboards:

### 5.1 Outbox Backlog & Processing Rate
```sql
SELECT 
  count(*) FILTER (WHERE processed_at IS NULL) AS unprocessed_backlog,
  count(*) FILTER (WHERE processed_at >= now() - interval '1 hour') AS processed_last_hour,
  max(now() - created_at) FILTER (WHERE processed_at IS NULL) AS oldest_pending_age
FROM gymos.workspace_outbox;
```
*Healthy State:* `unprocessed_backlog` is close to 0, and `oldest_pending_age` is under 10 seconds.

### 5.2 Event Log Storage Footprint
```sql
SELECT 
  count(*) AS total_events,
  pg_size_pretty(pg_total_relation_size('gymos.workspace_events')) AS table_size,
  min(revision) AS earliest_revision,
  max(revision) AS latest_revision
FROM gymos.workspace_events;
```

### 5.3 Manual Pruning (Maintenance)
To manually trigger pruning across all clubs:
```sql
SELECT 
  user_id AS owner, 
  gymos.prune_workspace_events(user_id, 10000) AS pruned_events
FROM gymos.gym_states;
```

---

## 6. Rollback Procedures

If an unexpected production issue arises:

### 6.1 Soft Rollback (Application Level)
Revert the Next.js deployment to the previous commit. Older code simply ignores the `workspace_events` and `workspace_outbox` tables and will continue using full snapshot loads and mutations normally.

### 6.2 Hard Rollback (Database Level)
If you need to completely drop the new tables and triggers:
```sql
DROP TABLE IF EXISTS gymos.workspace_outbox CASCADE;
DROP TABLE IF EXISTS gymos.workspace_events CASCADE;
DROP FUNCTION IF EXISTS gymos.prune_workspace_events(text, integer);
```
*Note: Dropping these tables does NOT affect existing gym members, subscriptions, visits, or invoices, which reside safely in `gymos.gym_states` and `gymos.gym_entities`.*
