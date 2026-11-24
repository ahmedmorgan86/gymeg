import 'server-only';
import type {PoolClient} from 'pg';
import {platformOwnerAccountId} from './platform-owner-license.ts';
/** Approved 23 Nov: only new quote requests and submitted transfers, only the
 * verified platform owner's registered Support devices. No payload/customer data.
 * Caller owns the business transaction. Default OFF pending schema/worker rollout. */
export const SUPPORT_ALERT_TITLE='GymEG Support';
export const SUPPORT_ALERT_BODY='في طلب جديد محتاج مراجعتك / A new request needs your review';
export const SUPPORT_ALERT_URL='/platform';
export type SupportBusinessEvent='quote_requested'|'transfer_submitted';
export async function enqueueSupportBusinessAlert(c:Pick<PoolClient,'query'>,orderId:string,event:SupportBusinessEvent){
 if(process.env.GYMOS_SUPPORT_BUSINESS_ALERTS!=='1')return{status:'disabled' as const};
 const recipient=platformOwnerAccountId();
 if(!recipient)throw Error('verified Support recipient binding required');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)||!['quote_requested','transfer_submitted'].includes(event))throw Error('invalid Support event');
 const r=await c.query('SELECT gymos.support_business_alert_enqueue($1,$2,$3) AS queued',[orderId,event,recipient]);
 return{status:r.rows[0].queued?'queued' as const:'duplicate' as const};
}
