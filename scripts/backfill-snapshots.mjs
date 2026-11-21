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
//   1. Counts the club's documents with Firestore count() aggregation
//      (billed ~1 read per 1000 index entries - never an unbounded probe),
//      so the spend is known BEFORE any scan.
//   2. Performs exactly ONE bounded scan through the normal read path
//      (bounded by GYMEG_MAX_SCAN_DOCS which YOU must set deliberately for
//      this run - the in-app default of 2,000 is intentionally too small for
//      big clubs). The read path backfills a revision snapshot, so every
//      later cold read costs 1 + chunks document reads.
//   3. Prints the measured counts and the resulting snapshot size.
//   A failure on one owner does not stop the others; the exit code is
//   non-zero if any owner failed.
//
// Run with the production service account in the environment:
//   GYMEG_FIREBASE_SERVICE_ACCOUNT='{...}' \
//   GYMEG_MAX_SCAN_DOCS=25000 \
//   node scripts/backfill-snapshots.mjs tenant:<clubId> [tenant:<clubId2> ...]
//
// Add --dry-run to only measure counts (aggregation reads) without scanning
// or writing anything.
import { pathToFileURL } from 'node:url';
import { getFirestoreDb, firestoreReadSpace } from '../app/lib/firestore-db.ts';

export async function runBackfill(argv, { log = console.log, warn = console.warn } = {}) {
  const args = argv.filter(a => a !== '--dry-run');
  const dryRun = argv.includes('--dry-run');

  if (args.length === 0) {
    throw new Error('usage: GYMEG_MAX_SCAN_DOCS=<budget> node scripts/backfill-snapshots.mjs <owner> [owner...] [--dry-run]');
  }
  if (!process.env.GYMEG_MAX_SCAN_DOCS) {
    throw new Error('Refusing to run without an explicit GYMEG_MAX_SCAN_DOCS budget. Set it deliberately for this run.');
  }

  const db = getFirestoreDb();
  const failed = [];

  for (const owner of args) {
    try {
      let entityCount = 'unknown', photoCount = 'unknown';
      try {
        const [e, p] = await Promise.all([
          db.collection('gym_entities').where('owner_id', '==', owner).count().get(),
          db.collection('gym_photos').where('owner_id', '==', owner).count().get(),
        ]);
        entityCount = e.data().count;
        photoCount = p.data().count;
      } catch (error) {
        warn(`${owner}: count aggregation unavailable (${error.message}); proceeding without a pre-count`);
      }
      log(`${owner}: ${entityCount} entity docs + ${photoCount} photo docs (budget ${process.env.GYMEG_MAX_SCAN_DOCS})`);
      if (dryRun) continue;

      const before = Date.now();
      const { revision } = await firestoreReadSpace(owner); // ONE bounded scan + backfills the snapshot
      const snaps = await db.collection('gym_state_snapshots').doc(`${owner}_0`).get();
      const chunks = snaps.exists ? snaps.data().chunks : 0;
      log(`${owner}: revision ${revision} bootstrapped, snapshot chunks=${chunks}, cold reads now cost ~${1 + chunks} docs (${Date.now() - before}ms)`);
    } catch (error) {
      failed.push(owner);
      warn(`${owner}: FAILED - ${error.message}`);
    }
  }

  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${args.length} owners failed: ${failed.join(', ')}`);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runBackfill(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
