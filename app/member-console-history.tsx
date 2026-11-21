'use client';
// Member console attendance history, paged. Same rows and order as the legacy `visits.filter(member).reverse()` (position descending), 25 per page.
import {useCallback,useEffect,useRef,useState} from 'react';
import styles from './member-console.module.css';
type Visit={id:string;at:string;leftAt?:string;exitType?:string;sessions?:{at:string;leftAt:string}[]};
export default function MemberConsoleHistory({member,owner,t,fallback,pageSize=25}:{member:string;owner:string;t:(a:string,b:string)=>string;/** already-loaded visits, used only when the paged route is unavailable (404/501) */fallback?:Visit[];pageSize?:number}){
 const [rows,setRows]=useState<Visit[]>([]),[next,setNext]=useState<number|null>(null),[state,setState]=useState<'loading'|'ok'|'error'|'unavailable'>('loading'),started=useRef(0);
 const load=useCallback(async(before?:number)=>{const ticket=++started.current;setState('loading');
  for(let attempt=0;attempt<3;attempt++){try{
   const q=new URLSearchParams({member,collection:'visits',limit:String(pageSize)});if(before!==undefined)q.set('before',String(before));
   const r=await fetch('/api/workspace/member-history?'+q,{credentials:'same-origin',headers:owner?{'X-GymOS-Tenant':owner}:{}});
   if(r.status===409)continue;
   if(r.status===404||r.status===501){if(ticket===started.current)setState('unavailable');return;}
   if(!r.ok)throw Error(String(r.status));const page=await r.json() as {rows:Visit[];next:number|null};
   if(ticket!==started.current)return;setRows(old=>before===undefined?page.rows:[...old,...page.rows]);setNext(page.next);setState('ok');return;
  }catch{break;}}
  if(ticket===started.current)setState('error');
 },[member,owner,pageSize]);
 useEffect(()=>{setRows([]);setNext(null);void load();return()=>{started.current++;};},[load]);
 const list=state==='unavailable'&&fallback?fallback.slice().reverse():rows;
 return <div data-testid="console-visit-history">{list.map(v=><article key={v.id} className={styles.history}><p>{t('الدخول:','Check-in:')} {v.at} · {t('المغادرة:','Check-out:')} {v.leftAt??t('جلسة مفتوحة','Open session')} · {v.exitType==='automatic'?t('خروج إداري تلقائي','Automatic administrative exit'):v.exitType==='device'?t('خروج من الجهاز','Device exit'):t('خروج يدوي / سجل سابق','Manual exit / earlier record')}</p>{v.sessions?.map((a,i)=><p key={i}>{a.at} ← {a.leftAt}</p>)}</article>)}
  {state==='unavailable'&&!fallback&&<p role="alert">{t('سجل الحضور غير متاح حاليا.','Attendance history is unavailable right now.')}</p>}
  {state==='error'&&<p role="alert">{t('تعذر تحميل السجل.','Could not load the history.')} <button type="button" onClick={()=>void load()}>{t('إعادة المحاولة','Retry')}</button></p>}
  {state==='loading'&&<p aria-busy="true">{t('جار التحميل…','Loading…')}</p>}
  {state==='ok'&&next!==null&&<button type="button" onClick={()=>void load(next)}>{t('عرض الأقدم','Show older')}</button>}</div>;
}
