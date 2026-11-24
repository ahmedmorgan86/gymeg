import 'server-only';
import type {PoolClient} from 'pg';
/** Synthetic rehearsal only. No production event semantics or route is wired.
 * Use inside the same caller-owned business transaction, never after COMMIT.
 * SQL independently restricts the event namespace/kind on the isolated target.
 */
export async function enqueueSyntheticSupportAlert(client:Pick<PoolClient,'query'>,eventId:string){
 if(process.env.GYMOS_SYNTHETIC_SUPPORT_ENQUEUE!=='1')return{status:'disabled' as const};
 const target=new URL(process.env.DATABASE_URL??'postgresql://disabled@localhost/disabled');
 if(target.username!=='gymos_app.dmovbpjuiapttdnoevhs'||target.hostname!=='aws-1-us-east-1.pooler.supabase.com'||target.port!=='5432')throw Error('isolated Support target required');
 if(!/^synthetic:[a-zA-Z0-9-]{16,100}$/.test(eventId))throw Error('synthetic event required');
 const result=await client.query('SELECT gymos.support_alert_enqueue($1,$2) AS queued',[eventId,'synthetic.acceptance']);
 return{status:result.rows[0].queued?'queued' as const:'duplicate' as const};
}
