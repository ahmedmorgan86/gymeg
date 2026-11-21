// One-off migration: drop reversibly-encrypted member PINs (pin_cipher) from
// Firestore member_code_access documents. PINs are stored hash-only; staff see
// a PIN once at creation/reset and rotate it instead of revealing it later.
//
// Run with the production service account in the environment:
//   GYMEG_FIREBASE_SERVICE_ACCOUNT='{...}' node scripts/migrate-pin-hash-only.mjs
// Add --dry-run to only count affected documents.
import { getFirestoreDb } from '../app/lib/firestore-db.ts';

const dryRun = process.argv.includes('--dry-run');
const db = getFirestoreDb();

let scanned = 0;
let affected = 0;
let batch = db.batch();
let pending = 0;

const snapshot = await db.collection('member_code_access').get();
for (const doc of snapshot.docs) {
  scanned++;
  const data = doc.data();
  if (typeof data.pin_cipher === 'string' && data.pin_cipher) {
    affected++;
    if (!dryRun) {
      batch.update(doc.ref, { pin_cipher: null });
      pending++;
      if (pending >= 400) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
  }
}
if (!dryRun && pending > 0) await batch.commit();

console.log(`${dryRun ? '[dry-run] would clear' : 'Cleared'} pin_cipher on ${affected} of ${scanned} member_code_access documents.`);
