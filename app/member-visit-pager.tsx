'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
/** Flag-gated (NEXT_PUBLIC_GYMOS_MEMBER_HISTORY=1) paged visit list for the member profile. Reads GET /api/workspace/member-history. */
export const memberHistoryClientEnabled=()=>process.env.NEXT_PUBLIC_GYMOS_MEMBER_HISTORY==='1';
type Row={id?:string;at?:string};
export default function MemberVisitPager({member,owner,ar,timeZone,pageSize=25}:{member:string;owner:string;ar:boolean;timeZone:string;pageSize?:number}){
 const [rows,setRows]=useState<Row[]>([]),[next,setNext]=useState<number|null>(null),[state,setState]=useState<'loading'|'ok'|'error'>('loading'),started=useRef(0);
 const load=useCallback(async(before?:number)=>{const ticket=++started.current;setState('loading');
  for(let attempt=0;attempt<3;attempt++){try{
   const q=new URLSearchParams({member,collection:'visits',limit:String(pageSize)});if(before!==undefined)q.set('before',String(before));
   const r=await fetch('/api/workspace/member-history?'+q,{credentials:'same-origin',headers:owner?{'X-GymOS-Tenant':owner}:{}});
   if(r.status===409)continue; // a write raced the read: retry
   if(!r.ok)throw Error(String(r.status));const page=await r.json() as {rows:Row[];next:number|null};
   if(ticket!==started.current)return;setRows(old=>before===undefined?page.rows:[...old,...page.rows]);setNext(page.next);setState('ok');return;
  }catch{break;}}
  if(ticket===started.current)setState('error');
 },[member,owner,pageSize]);
 useEffect(()=>{setRows([]);setNext(null);void load();return()=>{started.current++;};},[load]);
 const t=(a:string,e:string)=>ar?a:e;
 return <div data-testid="visit-pager">{rows.map((v,i)=><p key={v.id??i}>{new Date(String(v.at)).toLocaleString(ar?'ar-EG':'en-GB',{timeZone})}</p>)}
  {state==='ok'&&!rows.length&&<p>{t('لا توجد زيارات بعد.','No visits yet.')}</p>}
  {state==='error'&&<p role="alert">{t('تعذر تحميل الزيارات.','Could not load visits.')} <button type="button" onClick={()=>void load()}>{t('إعادة المحاولة','Retry')}</button></p>}
  {state==='loading'&&<p aria-busy="true">{t('جار التحميل…','Loading…')}</p>}
  {state==='ok'&&next!==null&&<button type="button" onClick={()=>void load(next)}>{t('عرض الأقدم','Show older')}</button>}</div>;
}
