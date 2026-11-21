import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getFirestore, type Firestore, FieldValue } from 'firebase-admin/firestore';
import { emptyState, type GymState } from './domain.ts';
import { normalize } from './extensions.ts';
import { assembleState, splitState, entityChanges, type Entity } from './entity-state.ts';
import { assertGrowth, CommercialError, licenseState, type License } from './licensing.ts';
import {memberAccessRef,memberCredentialFor} from './firebase-member-auth.ts';
import {newMemberPin,normalizeMemberPhone} from './member-phone.ts';

let firestoreInstance: Firestore | null = null;

// Revision-keyed in-memory cache of assembled workspace states. Firestore
// reads dominate quota and latency: without this, every page load, presence
// poll and mutation re-reads every entity document of the club. The state
// document's revision is bumped transactionally with every entity write, so a
// cache entry keyed by (owner, revision) is always correct; a revision match
// costs exactly one document read instead of a full collection scan.
type CachedSpace = { revision: number; state: GymState };
const spaceCache = new Map<string, CachedSpace>();
const SPACE_CACHE_LIMIT = 12;

function cacheSpace(owner: string, revision: number, state: GymState) {
  spaceCache.delete(owner);
  spaceCache.set(owner, { revision, state: structuredClone(state) });
  while (spaceCache.size > SPACE_CACHE_LIMIT) {
    const oldest = spaceCache.keys().next().value;
    if (oldest === undefined) break;
    spaceCache.delete(oldest);
  }
}

function cachedSpace(owner: string, revision: number): GymState | null {
  const hit = spaceCache.get(owner);
  if (!hit || hit.revision !== revision) return null;
  // LRU touch; callers receive a copy so route handlers can never mutate the
  // shared entry.
  spaceCache.delete(owner);
  spaceCache.set(owner, hit);
  return structuredClone(hit.state);
}

/** Test hook: drops the in-instance workspace cache so tests can measure cold reads. */
export function __clearSpaceCacheForTests(): void {
  spaceCache.clear();
}

/** Reads only the state document: the cheapest way to learn an owner's revision. */
export async function firestoreReadRevision(owner: string): Promise<number> {
  const db = getFirestoreDb();
  const snap = await db.collection('gym_states').doc(owner).get();
  return snap.exists ? ((snap.data() as { revision?: number }).revision ?? 0) : 0;
}

// Firestore rejects undefined values inside documents; entity payloads carry
// optional fields, so strip them before writing (JSON round-trip).
// Revision snapshots: chunk size stays comfortably under Firestore's 1 MiB
// document limit; states needing more than SNAPSHOT_MAX_CHUNKS chunks skip
// snapshotting and keep the entity-scan read path.
const SNAPSHOT_CHUNK_BYTES = 700_000;
const SNAPSHOT_MAX_CHUNKS = 8;
const snapshotRef = (db: Firestore, owner: string, chunk: number) =>
  db.collection('gym_state_snapshots').doc(`${owner}_${chunk}`);

// Circuit breaker for the entity-scan and photo-reattach read paths: a single
// read may never pull more documents than this (override with
// GYMEG_MAX_SCAN_DOCS). Over the cap the read fails closed instead of silently
// burning the daily quota; a snapshot backfill (below) is what makes scans
// one-time per club. Read at call time so tests and operators can adjust it.
function maxScanDocs(): number {
  // Default 2,000 docs per operation (~4% of the Spark daily read quota), so
  // one cold read can never take a meaningful bite out of the day. Existing
  // clubs above this are bootstrapped by the explicit operator script
  // (scripts/backfill-snapshots.mjs), never by a hidden scan on a user's
  // first visit; that script sets GYMEG_MAX_SCAN_DOCS deliberately.
  return Math.max(100, Number(process.env.GYMEG_MAX_SCAN_DOCS) || 2_000);
}
export class ScanBudgetError extends Error {
  readonly scanned: number;
  readonly cap: number;
  constructor(scanned: number, cap: number) {
    super(`scanBudget:${scanned}>${cap}`);
    this.scanned = scanned;
    this.cap = cap;
  }
}

// Builds gzipped snapshot chunks for a state, or null when the stripped state
// is too large to snapshot. Member photo payloads are EXCLUDED: they already
// live as individual gym_photos documents written in the same transaction, so
// embedding them would duplicate the largest bytes of the club into every
// snapshot write and push photo-heavy clubs past the chunk cap. The ids of
// stripped members ride along so a reader can re-attach the photos.
function buildSnapshotChunks(state: GymState): { chunks: Buffer[]; photoIds: string[] } | null {
  const photoIds: string[] = [];
  const slim = {
    ...state,
    members: state.members.map(member => {
      if (typeof member.photo !== 'string' || member.photo.length === 0) return member;
      photoIds.push(member.id);
      const { photo: _stripped, ...rest } = member;
      return rest;
    }),
  };
  const buffer = gzipSync(JSON.stringify({ s: slim, p: photoIds }));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += SNAPSHOT_CHUNK_BYTES) {
    chunks.push(buffer.subarray(offset, offset + SNAPSHOT_CHUNK_BYTES));
  }
  return chunks.length >= 1 && chunks.length <= SNAPSHOT_MAX_CHUNKS ? { chunks, photoIds } : null;
}

// Best-effort snapshot backfill after a legacy entity-scan read: later cold
// reads of this revision cost 1 + chunks document reads instead of another
// full scan. Race-safe: the chunks and the state document's chunk count are
// written in one transaction that first re-verifies the revision, so a backfill
// can never overwrite a newer revision's snapshot or clobber its chunk count;
// a racing persist simply wins and its own in-transaction snapshot stands.
async function backfillSnapshot(db: Firestore, owner: string, revision: number, state: GymState): Promise<void> {
  try {
    const built = buildSnapshotChunks(state);
    if (!built) return;
    const stateDocRef = db.collection('gym_states').doc(owner);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(stateDocRef);
      if (!snap.exists || (snap.data() as { revision?: number }).revision !== revision) return; // lost the race
      built.chunks.forEach((chunk, index) => {
        tx.set(snapshotRef(db, owner, index), { revision, chunks: built.chunks.length, data: chunk });
      });
      tx.update(stateDocRef, { _snapshotChunks: built.chunks.length });
    });
  } catch (error) {
    console.warn('snapshot_backfill_failed', error);
  }
}

// Reads the gzipped snapshot chunks for an exact revision and re-attaches
// member photos from their gym_photos documents. Returns null when no
// complete snapshot for that revision exists; never returns a state for a
// different revision, so a snapshot can never serve stale data after another
// writer has advanced the state document. A failed Firestore read is NOT a
// missing snapshot: it is logged and rethrown so a transient error is never
// silently converted into a full entity scan. Only a corrupt payload (which
// no retry would fix) falls back to the bounded scan, and that is logged too.
async function readSnapshot(db: Firestore, owner: string, revision: number): Promise<GymState | null> {
  let packed: { s: GymState; p: string[] };
  try {
    const first = await snapshotRef(db, owner, 0).get();
    if (!first.exists) return null;
    const meta = first.data() as { revision?: number; chunks?: number; data?: Buffer };
    if (meta.revision !== revision || typeof meta.chunks !== 'number' || meta.chunks < 1 || meta.chunks > SNAPSHOT_MAX_CHUNKS || !meta.data) return null;
    const parts: Buffer[] = [Buffer.from(meta.data)];
    for (let index = 1; index < meta.chunks; index++) {
      const part = await snapshotRef(db, owner, index).get();
      const partData = part.exists ? (part.data() as { data?: Buffer }).data : undefined;
      if (!partData) return null;
      parts.push(Buffer.from(partData));
    }
    packed = JSON.parse(gunzipSync(Buffer.concat(parts)).toString('utf8')) as { s: GymState; p: string[] };
  } catch (error) {
    // A corrupt payload (bad gzip/JSON) is permanent: log it and fall back
    // to the bounded scan, whose backfill repairs the snapshot. Anything
    // else (network, quota, permissions) is transient: fail closed rather
    // than convert it into a full entity scan.
    const corrupt = error instanceof SyntaxError || (typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('Z_'));
    if (corrupt) {
      console.warn('snapshot_corrupt_fallback_scan', error);
      return null;
    }
    console.error('snapshot_read_failed', error);
    throw error;
  }
  const photoIds = Array.isArray(packed.p) ? packed.p : [];
  if (photoIds.length > 0) {
    if (photoIds.length > maxScanDocs()) throw new ScanBudgetError(photoIds.length, maxScanDocs());
    const docs = await Promise.all(photoIds.map(id => db.collection('gym_photos').doc(`${owner}_${id}`).get()));
    const photos: Record<string, string> = {};
    docs.forEach((doc, index) => {
      const content = doc.exists ? (doc.data() as { content?: string }).content : undefined;
      if (typeof content === 'string') photos[photoIds[index]] = content;
    });
    packed.s.members = packed.s.members.map(member => (photos[member.id] ? { ...member, photo: photos[member.id] } : member));
    const missing = photoIds.length - Object.keys(photos).length;
    if (missing > 0) {
      // Counts only - never member ids or content.
      console.warn(`snapshot_photos_missing owner=${owner} missing=${missing} of=${photoIds.length}`);
    }
    // The photo reads above are not in the snapshot's transaction: a persist
    // that advanced the revision while they ran would leave new photos on the
    // old state. Re-verify the revision (one extra read, only on the photo
    // path) and let a mismatch fall back to the bounded scan.
    const recheck = await db.collection('gym_states').doc(owner).get();
    const latest = recheck.exists ? (recheck.data() as { revision?: number }).revision : undefined;
    if (latest !== revision) {
      console.warn('snapshot_raced_during_photo_reattach');
      return null;
    }
  }
  return packed.s;
}

function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isFirebaseConfigured(): boolean {
  return Boolean(
    process.env.GYMEG_FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
  );
}

export function getFirestoreDb(): Firestore {
  if (firestoreInstance) return firestoreInstance;

  const existingApp = getApps().find(app => app.name === 'gymeg-workspace');
  if (!existingApp) {
    const rawSa = process.env.GYMEG_FIREBASE_SERVICE_ACCOUNT;
    let sa;
    if (rawSa) {
      try {
        sa = typeof rawSa === 'string' ? JSON.parse(rawSa) : rawSa;
      } catch (err) {
        throw new Error('Invalid GYMEG Firebase service account; refusing to use another project', { cause: err });
      }
    }
    // The service-account JSON already carries project_id, so it alone is
    // enough to connect; an explicit project env still wins and must match.
    const projectId =
      process.env.GYMEG_FIREBASE_PROJECT_ID ||
      process.env.FIREBASE_PROJECT_ID ||
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      sa?.project_id;

    if (!projectId) throw new Error('GYMEG Firebase project ID is required');

    if (sa) {
      if (sa.project_id !== projectId) throw new Error('GYMEG Firebase service account project mismatch');
      initializeApp({
        credential: cert(sa),
        projectId,
      }, 'gymeg-workspace');
    } else {
      initializeApp({ projectId }, 'gymeg-workspace');
    }
  }

  firestoreInstance = getFirestore(getApps().find(app => app.name === 'gymeg-workspace')!);
  return firestoreInstance;
}

// A club that trips the scan guard gets a durable marker so every later cold
// instance fails fast (one marker read) instead of each spending ~cap+1 docs
// to rediscover the same over-budget club. The marker carries a TTL: after it
// expires one bounded scan is retried, which is also how recovery happens
// after an operator trims data or raises the budget deliberately.
const SCAN_GUARD_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Reads space from Firestore 'gym_states' collection (and entities if split).
 */
export async function firestoreReadSpace(owner: string): Promise<{ state: GymState; revision: number }> {
  return readSpaceWithRetry(owner, false);
}

async function readSpaceWithRetry(owner: string, isRetry: boolean): Promise<{ state: GymState; revision: number }> {
  const db = getFirestoreDb();
  const stateDocRef = db.collection('gym_states').doc(owner);
  const snap = await stateDocRef.get();

  if (!snap.exists) {
    const initial = emptyState();
    const data = {
      user_id: owner,
      payload: JSON.stringify(initial),
      revision: 0,
      updated_at: new Date().toISOString(),
    };
    await stateDocRef.set(data);
    return { state: initial, revision: 0 };
  }

  const data = snap.data() as { payload: string; revision: number };
  const parsedMeta = JSON.parse(data.payload);

  if (parsedMeta._entityStorage === 1) {
    const cached = cachedSpace(owner, data.revision);
    if (cached) return { state: cached, revision: data.revision };

    // Cold read: prefer the revision snapshot written by persist (1 + chunks
    // document reads). Fall back to the entity scan only when no matching
    // snapshot exists (states written before snapshots, or oversized states).
    const snapshot = await readSnapshot(db, owner, data.revision);
    if (snapshot) {
      const state = normalize(snapshot as GymState);
      cacheSpace(owner, data.revision, state);
      return { state, revision: data.revision };
    }

    // Cross-instance circuit breaker: a recent guard trip fails this cold
    // instance fast instead of spending ~cap+1 docs per instance.
    const guardRef = db.collection('gym_scan_guard').doc(owner);
    const guardSnap = await guardRef.get();
    const guardData = guardSnap.exists ? guardSnap.data() as { blockedAt?: string; scanned?: number } : undefined;
    const blockedAt = Date.parse(guardData?.blockedAt ?? '');
    // Block only while the recorded over-budget count still exceeds the
    // current cap: an operator who deliberately raises GYMEG_MAX_SCAN_DOCS
    // (the bootstrap script) is not blocked by an earlier trip.
    const stillOverBudget = typeof guardData?.scanned !== 'number' || guardData.scanned > maxScanDocs();
    if (Number.isFinite(blockedAt) && Date.now() - blockedAt < SCAN_GUARD_TTL_MS && stillOverBudget) {
      throw new ScanBudgetError(-1, maxScanDocs()); // blocked by a recent trip; -1 = no scan attempted
    }
    const tripGuard = async (scanned: number): Promise<void> => {
      try {
        await guardRef.set({ owner_id: owner, blockedAt: new Date().toISOString(), scanned, cap: maxScanDocs() });
      } catch (error) {
        console.warn('scan_guard_mark_failed', error);
      }
    };

    // Read entities. Bounded: .limit(cap+1) makes Firestore itself cap the
    // returned documents, so the budget is enforced before the full fetch,
    // and over-budget clubs fail closed rather than burn the daily quota.
    const entitiesSnap = await db.collection('gym_entities')
      .where('owner_id', '==', owner)
      .orderBy('collection')
      .orderBy('position')
      .limit(maxScanDocs() + 1)
      .get();
    if (entitiesSnap.docs.length > maxScanDocs()) {
      await tripGuard(entitiesSnap.docs.length);
      throw new ScanBudgetError(entitiesSnap.docs.length, maxScanDocs());
    }
    const entities = entitiesSnap.docs.map(d => d.data() as Entity);

    // Read photos. The remaining budget is always >= 1 here because the
    // entities check above already threw when the cap was exceeded.
    const photosSnap = await db.collection('gym_photos')
      .where('owner_id', '==', owner)
      .limit(maxScanDocs() - entitiesSnap.docs.length + 1)
      .get();
    if (entitiesSnap.docs.length + photosSnap.docs.length > maxScanDocs()) {
      await tripGuard(entitiesSnap.docs.length + photosSnap.docs.length);
      throw new ScanBudgetError(entitiesSnap.docs.length + photosSnap.docs.length, maxScanDocs());
    }
    const photos = Object.fromEntries(
      photosSnap.docs.map(d => {
        const pd = d.data();
        return [pd.member_id, pd.content];
      })
    );

    // The scan is not transactional: a persist that raced it leaves a state
    // assembled from mixed revisions. Never serve or cache that: re-verify
    // the state revision after the scan and retry once from the top (the
    // racing persist's own snapshot usually serves the retry). If it races
    // again, fail closed; the next request retries.
    const recheck = await stateDocRef.get();
    const latestRevision = recheck.exists ? (recheck.data() as { revision?: number }).revision : undefined;
    if (latestRevision !== data.revision) {
      console.warn('scan_raced_persist', owner);
      if (isRetry) throw new Error('firestoreReadSpace raced concurrent writes twice; failing closed');
      return readSpaceWithRetry(owner, true);
    }

    const state = normalize(assembleState(parsedMeta, entities, photos));
    if (guardSnap.exists) await guardRef.delete(); // scan succeeded: clear any stale trip marker
    cacheSpace(owner, data.revision, state);
    // One-time bootstrap: persist a snapshot so later cold reads skip the scan.
    await backfillSnapshot(db, owner, data.revision, state);
    return { state, revision: data.revision };
  }

  return { state: normalize(parsedMeta as GymState), revision: data.revision };
}

/**
 * Persists space to Firestore with atomic revisions, entity diffs, event logs, and outbox.
 */
export async function firestorePersistSpace(
  owner: string,
  current: { state: GymState; revision: number },
  next: GymState,
  restore = false
): Promise<boolean> {
  const db = getFirestoreDb();
  const stateDocRef = db.collection('gym_states').doc(owner);

  // Domain operations retain a recent window. Archive events that leave that
  // window before changing the state document. Replays are idempotent and an
  // interrupted save can leave a harmless duplicate, never a missing event.
  const retained = new Set(next.events.map(event => event.id));
  const removedEvents = current.state.events.filter(event => !retained.has(event.id));
  for (let offset = 0; offset < removedEvents.length; offset += 200) {
    const batch = db.batch();
    for (const event of removedEvents.slice(offset, offset + 200)) {
      const docId = createHash('sha256').update(owner + '\0' + event.id).digest('hex');
      batch.set(db.collection('gym_activity_archive').doc(docId), { owner_id: owner, event_id: event.id, at: event.at, branch: event.branch, payload: event });
    }
    await batch.commit();
  }

  const persisted = await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateDocRef);
    const tenantId = owner.startsWith('tenant:') ? owner.slice(7) : null;
    const licenseDoc = tenantId ? await tx.get(db.collection('tenant_licenses').doc(tenantId)) : null;
    if (tenantId) {
      const license = licenseDoc?.data() as License | undefined;
      if (!license || !licenseState(license).writable) throw new CommercialError('licenseReadOnly', 403);
      assertGrowth(license.limits, { branches: current.state.branches.length, members: current.state.members.length }, { branches: next.branches.length, members: next.members.length });
    }
    const priorMembers = new Map(current.state.members.map(member => [member.id, member]));
    const updatedMembers = new Map(next.members.map(member => [member.id, member]));
    const changedMembers = [...new Set([...priorMembers.keys(), ...updatedMembers.keys()])].filter(id => {
      const before = priorMembers.get(id), after = updatedMembers.get(id);
      return !before || !after || before.phone !== after.phone || before.branch !== after.branch || before.archived !== after.archived || before.demo !== after.demo;
    });
    const credentials = await Promise.all(changedMembers.map(id => tx.get(memberAccessRef(owner, id))));
    if (!snap.exists) return false;
    const curData = snap.data() as { payload: string; revision: number };

    if (curData.revision !== current.revision) {
      console.warn('Firestore revision conflict: expected', current.revision, 'found', curData.revision);
      return false;
    }

    const first = JSON.parse(curData.payload)._entityStorage !== 1;
    for (let i = 0; i < changedMembers.length; i++) {
      const id = changedMembers[i], member = updatedMembers.get(id), before = priorMembers.get(id), prior = credentials[i].data();
      const ref = memberAccessRef(owner, id);
      if (!member || member.archived || member.demo || !normalizeMemberPhone(member.phone)) {
        if (prior) tx.update(ref, { inactive: true, version: (prior.version || 0) + 1 });
      } else if (!prior || before?.phone !== member.phone) {
        tx.set(ref, { owner_id: owner, ...memberCredentialFor(member, newMemberPin(), (prior?.version || 0) + 1) });
      } else if (before?.branch !== member.branch) tx.update(ref, { branch: member.branch });
      else if (prior.inactive) tx.update(ref, { inactive: false, version: (prior.version || 0) + 1 });
    }
    if (first || restore) {
      const recoveryRef = db.collection('gym_recovery').doc(crypto.randomUUID());
      tx.set(recoveryRef, {
        id: recoveryRef.id,
        owner_id: owner,
        payload: JSON.stringify(current.state),
        created_at: new Date().toISOString(),
      });
    }

    const before = splitState(current.state);
    // Keep every activity event until a durable Firestore archive and cursor
    // reader are deployed. Truncating here would permanently lose old events.
    const after = splitState(next);
    const { upserts, removed } = entityChanges(before.entities, after.entities, first);

    // Entity deletes
    for (const rem of removed) {
      const docId = `${owner}_${rem.collection}_${rem.entity_id}`;
      tx.delete(db.collection('gym_entities').doc(docId));
    }

    // Entity upserts
    for (const up of upserts) {
      const docId = `${owner}_${up.collection}_${up.entity_id}`;
      tx.set(db.collection('gym_entities').doc(docId), {
        owner_id: owner,
        collection: up.collection,
        entity_id: up.entity_id,
        position: up.position,
        branch: up.branch ?? null,
        payload: sanitize(up.payload),
      });
    }

    // Photos upserts / deletes
    for (const [id, content] of Object.entries(after.photos)) {
      if (first || before.photos[id] !== content) {
        const photoId = `${owner}_${id}`;
        tx.set(db.collection('gym_photos').doc(photoId), {
          owner_id: owner,
          member_id: id,
          content,
        });
      }
    }
    for (const id of Object.keys(before.photos)) {
      if (!(id in after.photos)) {
        const photoId = `${owner}_${id}`;
        tx.delete(db.collection('gym_photos').doc(photoId));
      }
    }

    after.metadata._activityArchive = 1;
    after.metadata._entityStorage = 1;
    const newRevision = current.revision + 1;

    // Revision snapshot: a gzipped copy of the whole assembled state, chunked
    // to stay under Firestore's 1 MiB document limit and written in this same
    // transaction, so it always matches the state document's revision. Cold
    // instances read it (1 + chunks document reads) instead of scanning every
    // entity document (~12.6 docs/member) to rebuild the state. Chunk count
    // rides on the state document so stale extra chunks from a larger older
    // state can be deleted here without an extra read. Oversized states skip
    // the snapshot; reads fall back to the entity scan for those revisions.
    const built = buildSnapshotChunks(next);
    if (!built) {
      // No sizes or content - just the fact and the owner key.
      console.warn(`snapshot_skipped_oversized owner=${owner} revision=${newRevision}`);
    }
    const previousChunks = typeof (curData as { _snapshotChunks?: unknown })._snapshotChunks === 'number'
      ? (curData as unknown as { _snapshotChunks: number })._snapshotChunks
      : 0;
    const snapshotWritten = built !== null;
    if (built) {
      built.chunks.forEach((chunk, index) => {
        tx.set(snapshotRef(db, owner, index), { revision: newRevision, chunks: built.chunks.length, data: chunk });
      });
    }
    for (let index = built ? built.chunks.length : 0; index < previousChunks; index++) {
      tx.delete(snapshotRef(db, owner, index));
    }

    // Update state doc
    tx.update(stateDocRef, {
      payload: JSON.stringify(after.metadata),
      revision: newRevision,
      updated_at: new Date().toISOString(),
      _snapshotChunks: built ? built.chunks.length : 0,
    });

    // Append workspace outbox
    const outboxId = crypto.randomUUID();
    tx.set(db.collection('workspace_outbox').doc(outboxId), {
      id: outboxId,
      owner_id: owner,
      tenant_id: tenantId || owner,
      channel: `club:${tenantId || owner}:workspace`,
      event: 'workspace.updated',
      payload: { revision: newRevision, tenantId: tenantId || owner, timestamp: new Date().toISOString() },
      created_at: new Date().toISOString(),
      processed_at: null,
    });

    // Delta document for incremental client sync. Clients pull only what
    // changed since their revision instead of re-downloading the whole club.
    // Best-effort: skipped when the change is not delta-expressible (metadata
    // beyond settings changed, photos changed, or the change is too large);
    // the changes endpoint then asks the client for a full snapshot.
    const metadataExpressible = (() => {
      const strip = (meta: Record<string, unknown>) => {
        const clone = { ...meta };
        delete clone.settings;
        delete clone._entityStorage;
        delete clone._activityArchive;
        return JSON.stringify(clone);
      };
      return strip(before.metadata as Record<string, unknown>) === strip(after.metadata as Record<string, unknown>);
    })();
    const photosUnchanged = JSON.stringify(before.photos) === JSON.stringify(after.photos);
    const settingsChanged = JSON.stringify((before.metadata as { settings?: unknown }).settings) !== JSON.stringify((after.metadata as { settings?: unknown }).settings);
    const changeCount = upserts.length + removed.length;
    const deltaBytes = changeCount > 0 || settingsChanged
      ? upserts.reduce((total, up) => total + JSON.stringify(up.payload).length, 0)
      : 0;
    if (metadataExpressible && photosUnchanged && changeCount <= 500 && deltaBytes <= 700_000) {
      const deltaRef = db.collection('gym_workspace_deltas').doc(`${owner}_${newRevision}`);
      tx.set(deltaRef, {
        owner_id: owner,
        revision: newRevision,
        created_at: new Date().toISOString(),
        upserts: upserts.map(up => ({ collection: up.collection, entity_id: up.entity_id, branch: up.branch ?? null, payload: sanitize(up.payload) })),
        removed: removed.map(rem => ({ collection: rem.collection, entity_id: rem.entity_id, branch: rem.branch ?? null })),
        settings: settingsChanged ? sanitize((after.metadata as { settings?: unknown }).settings ?? null) : null,
      });
    }

    return true;
  });

  // Prime the cache with the just-written state so the next read on this
  // instance (typically the client's own follow-up) costs one document read.
  if (persisted) cacheSpace(owner, current.revision + 1, next);
  return persisted;
}

/**
 * Fast Firestore connectivity health check.
 */
export async function firestoreCheckHealth(): Promise<boolean> {
  try {
    const db = getFirestoreDb();
    await db.collection('gym_states').limit(1).get();
    return true;
  } catch (error) {
    console.error('firestore_health_check_failed', error);
    return false;
  }
}
