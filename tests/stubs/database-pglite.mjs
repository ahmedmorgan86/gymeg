// Test double for app/lib/database.ts: serves consumePostgres from a PGlite
// instance so the real consume path runs against a real database.
let db = null;
export function __setDb(instance) { db = instance; }
export function getPool() {
  if (!db) throw new Error('PGlite test pool not attached');
  return { query: (sql, params) => db.query(sql, params) };
}
