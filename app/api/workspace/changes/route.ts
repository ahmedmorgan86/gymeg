import {context, reply, sameOrigin} from '../../../lib/server-workspace';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {withScope} from '../../../lib/database';

export async function GET(request: Request) {
  try {
    if (!sameOrigin(request)) return reply({error: 'origin'}, 403);

    const ctx = await context();
    if (!ctx) return reply({error: 'auth'}, 401);

    assertRequestTenant(request, ctx.tenantId, Boolean(ctx.license));

    const url = new URL(request.url);
    const afterParam = url.searchParams.get('after');
    const after = afterParam !== null ? parseInt(afterParam, 10) : 0;

    if (isNaN(after) || after < 0) {
      return reply({error: 'invalid'}, 400);
    }

    // A revision of 0 requires initial snapshot download
    if (after === 0) {
      return reply({
        requiresSnapshot: true,
        fromRevision: 0,
        toRevision: 0,
        hasMore: false,
        events: []
      });
    }

    const result = await withScope(ctx.owner, async client => {
      // 1. Check range of available revisions in durable event log
      const bounds = (await client.query(
        `SELECT min(revision)::int AS min_rev, max(revision)::int AS max_rev 
         FROM gymos.workspace_events 
         WHERE owner_id = $1`,
        [ctx.owner]
      )).rows[0] as {min_rev: number | null; max_rev: number | null};

      const minRev = bounds?.min_rev ?? null;
      const maxRev = bounds?.max_rev ?? null;

      // If client revision is already at or ahead of latest database revision
      if (maxRev !== null && after >= maxRev) {
        return {
          requiresSnapshot: false,
          fromRevision: after,
          toRevision: after,
          hasMore: false,
          events: []
        };
      }

      // If there are events in log, but client's revision is older than earliest retained revision,
      // or if gap is too large (> 500 events), trigger snapshot recovery
      if (minRev !== null && minRev > after + 1) {
        return {
          requiresSnapshot: true,
          fromRevision: after,
          toRevision: maxRev ?? after,
          hasMore: false,
          events: []
        };
      }

      // 2. Query deltas up to 250 items per batch
      const limit = 250;
      const rawEvents = (await client.query(
        `SELECT id, revision, event_type, collection, entity_id, branch, payload, created_at
         FROM gymos.workspace_events
         WHERE owner_id = $1 AND revision > $2
         ORDER BY revision ASC, id ASC
         LIMIT $3`,
        [ctx.owner, after, limit]
      )).rows;

      if (!rawEvents.length) {
        // No new events found
        return {
          requiresSnapshot: false,
          fromRevision: after,
          toRevision: after,
          hasMore: false,
          events: []
        };
      }

      // 3. Security, branch and role filtering
      const financial = ctx.role !== 'reception';

      const filteredEvents = rawEvents.filter(ev => {
        // Branch filtering
        if (ctx.branches && ev.branch && !ctx.branches.includes(ev.branch)) {
          return false;
        }
        return true;
      }).map(ev => {
        let payload = ev.payload;
        // Role masking for reception
        if (!financial && ev.collection === 'invoices' && payload) {
          payload = { ...payload, pricing: undefined, total: undefined };
        }
        return {
          id: ev.id,
          revision: ev.revision,
          eventType: ev.event_type,
          collection: ev.collection,
          entityId: ev.entity_id,
          branch: ev.branch,
          payload
        };
      });

      const lastRev = rawEvents[rawEvents.length - 1].revision;
      const hasMore = rawEvents.length === limit;

      return {
        requiresSnapshot: false,
        fromRevision: after,
        toRevision: lastRev,
        hasMore,
        events: filteredEvents
      };
    });

    return reply(result);
  } catch (err) {
    return reply({error: 'unavailable'}, 503);
  }
}
