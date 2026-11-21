// Explicit, operator-run snapshot bootstrap for existing clubs.
//
// Why this exists: a club whose data predates revision snapshots has no
// snapshot, and its first cold read would otherwise run a full entity scan
// hidden inside an ordinary user visit. That is real spend buried in a page
// load. This script makes the bootstrap an explicit, bounded, logged operator
// action instead: run it once per owner after deploying snapshots, before
// inviting users back in.
//
// What it does, per owner:
//   1. Reads the club once through the normal read path (entity scan, bounded
//      by GYMEG_MAX_SCAN_DOCS which YOU must set deliberately for this run -
//      the in-app default of 2,000 is intentionally too small for big clubs).
//   2. The read path backfills a revision snapshot as part of that read, so
//      every later cold read costs 1 + chunks document reads.
//   3. Prints the measured document cost so the spend is visible, not hidden.
//
// Run with the production service account in the environment:
//   GYMEG_FIREBASE_SERVICE_ACCOUNT='{...}' \
//   GYMEG_MAX_SCAN_DOCS=25000 \
//   node scripts/backfill-snapshots.mjs tenant:<clubId> [tenant:<clubId2> ...]
//
// Add --dry-run to measure the scan cost without writing any snapshot.
import { getFirestoreDb, firestoreReadSpace } from '../app/lib/firestore-db.ts';

const args = process.argv.slice(2).filter(a => a !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');

if (args.length === 0) {
  console.error('usage: GYMEG_MAX_SCAN_DOCS=<budget> node scripts/backfill-snapshots.mjs <owner> [owner...] [--dry-run]');
  process.exit(1);
}
if (!process.env.GYMEG_MAX_SCAN_DOCS) {
  console.error('Refusing to run without an explicit GYMEG_MAX_SCAN_DOCS budget. Set it deliberately for this run.');
  process.exit(1);
}

const db = getFirestoreDb();

for (const owner of args) {
  // Count what the entity scan would read, so the operator sees the spend.
  const entities = await db.collection('gym_entities').where('owner_id', '==', owner).get();
  const photos = await db.collection('gym_photos').where('owner_id', '==', owner).get();
  console.log(`${owner}: ${entities.size} entity docs + ${photos.size} photo docs = ${entities.size + photos.size} docs (budget ${process.env.GYMEG_MAX_SCAN_DOCS})`);
  if (dryRun) continue;

  const before = Date.now();
  const { revision } = await firestoreReadSpace(owner); // scans once + backfills the snapshot
  const snaps = await db.collection('gym_state_snapshots').doc(`${owner}_0`).get();
  const chunks = snaps.exists ? snaps.data().chunks : 0;
  console.log(`${owner}: revision ${revision} bootstrapped, snapshot chunks=${chunks}, cold reads now cost ~${1 + chunks} docs (${Date.now() - before}ms)`);
}
