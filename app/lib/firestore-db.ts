import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, FieldValue } from 'firebase-admin/firestore';
import { emptyState, type GymState } from './domain.ts';
import { normalize } from './extensions.ts';
import { assembleState, splitState, entityChanges, type Entity } from './entity-state.ts';
import { RECENT_EVENTS } from './activity-archive.ts';

let firestoreInstance: Firestore | null = null;

export function isFirebaseConfigured(): boolean {
  return Boolean(
    process.env.GYMEG_FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
  );
}

export function getFirestoreDb(): Firestore {
  if (firestoreInstance) return firestoreInstance;

  if (getApps().length === 0) {
    const rawSa = process.env.GYMEG_FIREBASE_SERVICE_ACCOUNT;
    const projectId =
      process.env.GYMEG_FIREBASE_PROJECT_ID ||
      process.env.FIREBASE_PROJECT_ID ||
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      'gymeg-app';

    if (rawSa) {
      try {
        const sa = typeof rawSa === 'string' ? JSON.parse(rawSa) : rawSa;
        initializeApp({
          credential: cert(sa),
          projectId: sa.project_id || projectId,
        });
      } catch (err) {
        console.error('Failed to parse GYMEG_FIREBASE_SERVICE_ACCOUNT, falling back to projectId', err);
        initializeApp({ projectId });
      }
    } else {
      initializeApp({ projectId });
    }
  }

  firestoreInstance = getFirestore();
  return firestoreInstance;
}

/**
 * Reads space from Firestore 'gym_states' collection (and entities if split).
 */
export async function firestoreReadSpace(owner: string): Promise<{ state: GymState; revision: number }> {
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
    // Read entities
    const entitiesSnap = await db.collection('gym_entities')
      .where('owner_id', '==', owner)
      .orderBy('collection')
      .orderBy('position')
      .get();
    const entities = entitiesSnap.docs.map(d => d.data() as Entity);

    // Read photos
    const photosSnap = await db.collection('gym_photos')
      .where('owner_id', '==', owner)
      .get();
    const photos = Object.fromEntries(
      photosSnap.docs.map(d => {
        const pd = d.data();
        return [pd.member_id, pd.content];
      })
    );

    const state = assembleState(parsedMeta, entities, photos);
    return { state: normalize(state), revision: data.revision };
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

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateDocRef);
    if (!snap.exists) return false;
    const curData = snap.data() as { payload: string; revision: number };

    if (curData.revision !== current.revision) {
      console.warn('Firestore revision conflict: expected', current.revision, 'found', curData.revision);
      return false;
    }

    const first = JSON.parse(curData.payload)._entityStorage !== 1;
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
    const after = splitState({ ...next, events: next.events.slice(-RECENT_EVENTS) });
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
        payload: up.payload,
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

    // Update state doc
    tx.update(stateDocRef, {
      payload: JSON.stringify(after.metadata),
      revision: newRevision,
      updated_at: new Date().toISOString(),
    });

    // Append workspace outbox
    const outboxId = crypto.randomUUID();
    tx.set(db.collection('workspace_outbox').doc(outboxId), {
      id: outboxId,
      owner_id: owner,
      tenant_id: owner,
      channel: `club:${owner}:workspace`,
      event: 'workspace.updated',
      payload: { revision: newRevision, tenantId: owner, timestamp: new Date().toISOString() },
      created_at: new Date().toISOString(),
      processed_at: null,
    });

    return true;
  });
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
