import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { createHash } from 'node:crypto';
import { getFirestore, type Firestore, FieldValue } from 'firebase-admin/firestore';
import { emptyState, type GymState } from './domain.ts';
import { normalize } from './extensions.ts';
import { assembleState, splitState, entityChanges, type Entity } from './entity-state.ts';
import { assertGrowth, CommercialError, licenseState, type License } from './licensing.ts';
import {memberAccessRef,memberCredentialFor} from './firebase-member-auth.ts';
import {newMemberPin,normalizeMemberPhone} from './member-phone.ts';

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

  return await db.runTransaction(async (tx) => {
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
      tenant_id: tenantId || owner,
      channel: `club:${tenantId || owner}:workspace`,
      event: 'workspace.updated',
      payload: { revision: newRevision, tenantId: tenantId || owner, timestamp: new Date().toISOString() },
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
