'use client';
import type {GymState} from './lib/domain';
import {dayAt} from './lib/domain';
import {manualWhatsAppDue} from './lib/manual-whatsapp';
import {useLastVisits,LAST_VISITS_ON,LAZY_STRICT} from './use-last-visits';
/** Overview is an independent consumer, not the dedicated WhatsApp page. Never
 * derive absence counts from the empty visits of a strict omitted packet. */
export default function WhatsAppDueCount({state,owner,branch,ar,now=new Date().toISOString()}:{state:GymState;owner?:string;branch:string;ar:boolean;now?:string}){
 const {last,failed,retry}=useLastVisits(state,owner,branch,dayAt(now,state.settings.timezone));
 const strict=LAZY_STRICT&&LAST_VISITS_ON&&!last,t=(a:string,e:string)=>ar?a:e;
 const count=strict?null:manualWhatsAppDue(state,branch,now,last).length;
 return <><h2 data-whatsapp-due-count>{count===null?'—':count}</h2>{(strict||failed)&&<p className="form-note" role="status">{failed?t('تعذر تحميل المتابعات.','Could not load follow-ups.'):t('جارٍ تحميل المتابعات…','Loading follow-ups…')}{failed&&<> <button type="button" className="button secondary" onClick={retry}>{t('إعادة المحاولة','Retry')}</button></>}</p>}</>;
}
