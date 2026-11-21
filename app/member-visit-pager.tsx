'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
/** Flag-gated (NEXT_PUBLIC_GYMOS_MEMBER_HISTORY=1) paged visit list for the member profile. Reads GET /api/workspace/member-history. */
export const memberHistoryClientEnabled=()=>process.env.NEXT_PUBLIC_GYMOS_MEMBER_HISTORY==='1';
type Row={id?:string;at?:string};
type RowAt=Row&{at:string};
export default function MemberVisitPager({member,owner,ar,timeZone,pageSize=25,fallback}:{member:string;owner:string;/** The caller's already-loaded visits for this member, used only when the server has no exact paged order (HTTP 501). Absent in a lazy bootstrap: no club-wide refetch. */fallback?:Row[];ar:boolean;timeZone:string;pageSize?:number}){
 const [rows,setRows]=useState<Row[]>([]),[next,setNext]=useState<string|null>(null),[state,setState]=useState<'loading'|'ok'|'error'|'unsupported'>('loading'),started=useRef(0);
 const load=useCallback(async(before?:string)=>{const ticket=++started.current;setState('loading');
  for(let attempt=0;attempt<3;attempt++){try{
   const q=new URLSearchParams({member,collection:'visits',order:'at',limit:String(pageSize)});if(before!==undefined)q.set('cursor',before);
   const r=await fetch('/api/workspace/member-history?'+q,{credentials:'same-origin',headers:owner?{'X-GymOS-Tenant':owner}:{}});
   if(r.status===409)continue; // a write raced the read: retry
   if(r.status===501){if(ticket===started.current)setState('unsupported');return;} // no exact server order for this member: not retryable
   if(!r.ok)throw Error(String(r.status));const page=await r.json() as {rows:Row[];nextCursor?:string|null};
   if(ticket!==started.current)return;setRows(old=>before===undefined?page.rows:[...old,...page.rows]);setNext(page.nextCursor??null);setState('ok');return;
  }catch{break;}}
  if(ticket===started.current)setState('error');
 },[member,owner,pageSize]);
 useEffect(()=>{setRows([]);setNext(null);void load();return()=>{started.current++;};},[load]);
 const t=(a:string,e:string)=>ar?a:e;
 const legacy=state==='unsupported'&&fallback?[...fallback].sort((a,b)=>String((b as RowAt).at).localeCompare(String((a as RowAt).at))):null;
 if(legacy)return <div data-testid="visit-pager" data-mode="legacy">{legacy.map((v,i)=><p key={v.id??i}>{new Date(String(v.at)).toLocaleString(ar?'ar-EG':'en-GB',{timeZone})}</p>)}{!legacy.length&&<p>{t('لا توجد زيارات بعد.','No visits yet.')}</p>}</div>;
 return <div data-testid="visit-pager">{state==='unsupported'&&<p role="alert">{t('لا يمكن عرض ترتيب الزيارات لهذا العضو حاليا.','The visit order for this member cannot be shown yet.')}</p>}{rows.map((v,i)=><p key={v.id??i}>{new Date(String(v.at)).toLocaleString(ar?'ar-EG':'en-GB',{timeZone})}</p>)}
  {state==='ok'&&!rows.length&&<p>{t('لا توجد زيارات بعد.','No visits yet.')}</p>}
  {state==='error'&&<p role="alert">{t('تعذر تحميل الزيارات.','Could not load visits.')} <button type="button" onClick={()=>void load()}>{t('إعادة المحاولة','Retry')}</button></p>}
  {state==='loading'&&<p aria-busy="true">{t('جار التحميل…','Loading…')}</p>}
  {state==='ok'&&next!==null&&<button type="button" onClick={()=>void load(next)}>{t('عرض الأقدم','Show older')}</button>}</div>;
}
