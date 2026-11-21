import { getPool } from '../../lib/database.ts';
import { firestoreCheckHealth ,useFirestorePersistence} from '../../lib/firestore-db.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    if (useFirestorePersistence()) {
      const ready = await firestoreCheckHealth();
      if (!ready) throw Error('Firestore not ready');
      return Response.json({ status: 'ready', provider: 'firebase' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const r = await getPool().query("SELECT to_regclass('gymos.gym_states') IS NOT NULL AS ready");
    if (!r.rows[0]?.ready) throw Error();
    return Response.json({ status: 'ready', provider: 'postgres' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('database_health', e);
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
