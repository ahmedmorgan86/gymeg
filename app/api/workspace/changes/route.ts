import {context, reply} from '../../../lib/server-workspace';
import {CommercialError} from '../../../lib/licensing';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {withScope} from '../../../lib/database';
import { firestoreReadRevision, getFirestoreDb,isFirestorePersistence} from '../../../lib/firestore-db';

export async function GET(request: Request) {
  try {
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

    if (isFirestorePersistence()) {
      // Revision check costs a single document read; when the client is
      // current, no entity document is touched at all.
      const revision = await firestoreReadRevision(ctx.owner);
      if (after >= revision) {
        return reply({
          requiresSnapshot: after > revision,
          fromRevision: after,
          toRevision: revision,
          hasMore: false,
          events: []
        });
      }

      // Pull the per-revision delta documents written by persist. Every
      // revision in (after, revision] must have one; a gap means that change
      // was not delta-expressible (or predates deltas) and the client must
      // re-download a full snapshot.
      const limit = 250;
      const snap = await getFirestoreDb().collection('gym_workspace_deltas')
        .where('owner_id', '==', ctx.owner)
        .where('revision', '>', after)
        .orderBy('revision', 'asc')
        .limit(limit + 1)
        .get();
      const docs = snap.docs.map(d => d.data() as {
        revision: number;
        upserts?: {collection: string; entity_id: string; branch: string | null; payload: unknown}[];
        removed?: {collection: string; entity_id: string; branch: string | null}[];
        settings?: unknown;
      });
      const hasMore = docs.length > limit;
      const usable = hasMore ? docs.slice(0, limit) : docs;
      const lastCovered = usable.length ? usable[usable.length - 1].revision : after;
      if (usable.length !== lastCovered - after || (!hasMore && lastCovered < revision)) {
        return reply({
          requiresSnapshot: true,
          fromRevision: after,
          toRevision: revision,
          hasMore: false,
          events: []
        });
      }

      const financial = ctx.role !== 'reception';
      const events: Record<string, unknown>[] = [];
      for (const doc of usable) {
        for (const up of doc.upserts ?? []) {
          if (ctx.branches && up.branch && !ctx.branches.includes(up.branch)) continue;
          let payload = up.payload;
          if (!financial && up.collection === 'invoices' && payload && typeof payload === 'object') {
            payload = {...(payload as Record<string, unknown>), pricing: undefined, total: undefined};
          }
          events.push({
            id: `${doc.revision}:${up.collection}:${up.entity_id}`,
            revision: doc.revision,
            eventType: 'entity.upsert',
            collection: up.collection,
            entityId: up.entity_id,
            branch: up.branch,
            payload
          });
        }
        for (const rem of doc.removed ?? []) {
          if (ctx.branches && rem.branch && !ctx.branches.includes(rem.branch)) continue;
          events.push({
            id: `${doc.revision}:${rem.collection}:${rem.entity_id}:del`,
            revision: doc.revision,
            eventType: 'entity.delete',
            collection: rem.collection,
            entityId: rem.entity_id,
            branch: rem.branch
          });
        }
        if (doc.settings) {
          events.push({
            id: `${doc.revision}:settings`,
            revision: doc.revision,
            eventType: 'metadata.update',
            payload: {settings: doc.settings}
          });
        }
      }

      return reply({
        requiresSnapshot: false,
        fromRevision: after,
        toRevision: lastCovered,
        hasMore,
        events
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

      // The authoritative revision lives on gym_states. An event log that does not reach it (the event insert is a savepoint that can roll back
      // while the revision still advances, or the table was never populated) cannot prove "nothing changed": a client behind the authoritative
      // revision gets a snapshot, never an empty delta that would leave it on a stale revision.
      const authoritative = (await client.query('SELECT revision FROM gymos.gym_states WHERE user_id=$1', [ctx.owner])).rows[0] as {revision: number | string} | undefined;
      const authRev = authoritative ? Number(authoritative.revision) : null;
      if (authRev !== null && after >= authRev) {
        return {requiresSnapshot: after > authRev, fromRevision: after, toRevision: authRev, hasMore: false, events: []};
      }
      if (authRev !== null && (maxRev === null || maxRev < authRev)) {
        return {requiresSnapshot: true, fromRevision: after, toRevision: authRev, hasMore: false, events: []};
      }

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
      const fetched = (await client.query(
        `SELECT id, revision, event_type, collection, entity_id, branch, payload, created_at
         FROM gymos.workspace_events
         WHERE owner_id = $1 AND revision > $2
         ORDER BY revision ASC, id ASC
         LIMIT $3`,
        [ctx.owner, after, limit + 1]
      )).rows;
      // A batch never ends inside a revision: the client's next pull resumes at the last applied revision, so events of a partly served revision would be skipped for good.
      // The extra row shows whether the last revision is complete; if not, the whole trailing revision waits for the next batch.
      const more = fetched.length > limit;
      let rawEvents = fetched;
      if (more) {
        const boundary = fetched[limit].revision;
        rawEvents = fetched[limit - 1].revision === boundary ? fetched.filter(ev => ev.revision < boundary) : fetched.slice(0, limit);
        if (!rawEvents.length) {
          // one revision alone exceeds the batch: it cannot be delivered atomically, so the client takes a snapshot
          return {requiresSnapshot: true, fromRevision: after, toRevision: authRev ?? boundary, hasMore: false, events: []};
        }
      }

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
      // Continuity: every revision in (after, lastRev] must have at least one event row. A revision with none is either a failed event insert
      // (the savepoint rolled back while the revision advanced) or a write with no entity change; the two cannot be told apart, so the client takes a
      // snapshot instead of applying a feed with a hole (a later healthy revision must not hide an earlier failed one).
      const covered = Number((await client.query('SELECT count(DISTINCT revision)::int AS n FROM gymos.workspace_events WHERE owner_id=$1 AND revision>$2 AND revision<=$3', [ctx.owner, after, lastRev])).rows[0]?.n ?? 0);
      if (covered !== lastRev - after) {
        return {requiresSnapshot: true, fromRevision: after, toRevision: authRev ?? lastRev, hasMore: false, events: []};
      }
      const hasMore = more;

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
    if (err instanceof CommercialError) return reply({error: err.code}, err.status);
    return reply(
      {error: err instanceof Error && err.message === 'forbidden' ? 'forbidden' : 'unavailable'},
      err instanceof Error && err.message === 'forbidden' ? 403 : 503
    );
  }
}
