/**
 * The members screen sorts "status" by the localized subscriptionLabel text (member-console.tsx), using
 * localeCompare('ar'). There are five labels per language, so the order is a finite rank. The rank is
 * built here from the same label strings and the same comparator, so it cannot drift from them.
 * Ties keep stored position order (stable sort), which the caller applies as the secondary key.
 */
export type StatusKey='expired'|'warning'|'active'|'quota'|'inactive';
export const STATUS_LABELS:Record<StatusKey,[string,string]>={expired:['انتهى الاشتراك','Expired'],warning:['قريب من الانتهاء','Expiring soon'],active:['اشتراك ساري','Active'],quota:['نفدت الحصص','Sessions exhausted'],inactive:['غير مفعل / غير متاح','Inactive / unavailable']};
/** Same decision order as subscriptionLabel: remaining<0, then warning, then active, then the quota issue, else inactive. */
export function statusKey(x:{remaining:number;status:string;issue:string|null}):StatusKey{
  return x.remaining<0?'expired':x.status==='warning'?'warning':x.status==='active'?'active':x.issue==='quota'?'quota':'inactive';
}
const collator=new Intl.Collator('ar');
export function statusRanks(ar:boolean):Record<StatusKey,number>{
  const keys=Object.keys(STATUS_LABELS) as StatusKey[],label=(k:StatusKey)=>STATUS_LABELS[k][ar?0:1];
  const order=[...keys].sort((a,b)=>collator.compare(label(a),label(b)));
  return Object.fromEntries(order.map((k,i)=>[k,i])) as Record<StatusKey,number>;
}
