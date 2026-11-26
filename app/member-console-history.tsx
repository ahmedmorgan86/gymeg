'use client';
// Member console attendance history, paged. Same rows and order as the legacy `visits.filter(member).reverse()` (position descending), 25 per page.
import {useCallback,useEffect,useRef,useState} from 'react';
import styles from './member-console.module.css';
type Visit={id:string;at:string;leftAt?:string;exitType?:string;sessions?:{at:string;leftAt:string}[]};
export default function MemberConsoleHistory({member,owner,t,fallback,pageSize=25}:{member:string;owner:string;t:(a:string,b:string)=>string;/** already-loaded visits, used only when the paged route is unavailable (404/501) */fallback?:Visit[];pageSize?:number}){
 const [rows,setRows]=useState<Visit[]>([]),[next,setNext]=useState<number|null>(null),[state,setState]=useState<'loading'|'ok'|'error'|'unavailable'>('loading'),started=useRef(0);
 const key=member+'|'+owner+'|'+pageSize,[dataKey,setDataKey]=useState(key); // rows/state below belong to dataKey; a new member/owner/pageSize renders loading until its own commit lands, never the previous member's rows
 const load=useCallback(async(before?:number)=>{const ticket=++started.current;setState('loading');
  if(before===undefined){setRows([]);setNext(null);}
  for(let attempt=0;attempt<3;attempt++){try{
   const q=new URLSearchParams({member,collection:'visits',limit:String(pageSize)});if(before!==undefined)q.set('before',String(before));
   const r=await fetch('/api/workspace/member-history?'+q,{credentials:'same-origin',headers:owner?{'X-GymOS-Tenant':owner}:{}});
   if(r.status===409)continue;
   if(r.status===404||r.status===501){if(ticket===started.current){setState('unavailable');setDataKey(key);}return;}
   if(!r.ok)throw Error(String(r.status));const page=await r.json() as {rows:Visit[];next:number|null};
   if(ticket!==started.current)return;setRows(old=>before===undefined?page.rows:[...old,...page.rows]);setNext(page.next);setState('ok');setDataKey(key);return;
  }catch{break;}}
  if(ticket===started.current){setState('error');setDataKey(key);}
 },[member,owner,pageSize,key]);
 useEffect(()=>{started.current++;const id=setTimeout(()=>void load(),0);return()=>{clearTimeout(id);};},[load]);
 const stale=dataKey!==key,effState=stale?'loading':state,effRows=stale?[]:rows;
 const list=effState==='unavailable'&&fallback?fallback.slice().reverse():effRows;
 return <div data-testid="console-visit-history">{list.map(v=><article key={v.id} className={styles.history}><p>{t('الدخول:','Check-in:')} {v.at} · {t('المغادرة:','Check-out:')} {v.leftAt??t('جلسة مفتوحة','Open session')} · {v.exitType==='automatic'?t('خروج إداري تلقائي','Automatic administrative exit'):v.exitType==='device'?t('خروج من الجهاز','Device exit'):t('خروج يدوي / سجل سابق','Manual exit / earlier record')}</p>{v.sessions?.map((a,i)=><p key={i}>{a.at} ← {a.leftAt}</p>)}</article>)}
  {effState==='unavailable'&&!fallback&&<p role="alert">{t('سجل الحضور غير متاح حاليا.','Attendance history is unavailable right now.')}</p>}
  {effState==='error'&&<p role="alert">{t('تعذر تحميل السجل.','Could not load the history.')} <button type="button" onClick={()=>void load()}>{t('إعادة المحاولة','Retry')}</button></p>}
  {effState==='loading'&&<p aria-busy="true">{t('جار التحميل…','Loading…')}</p>}
  {effState==='ok'&&next!==null&&<button type="button" onClick={()=>void load(next)}>{t('عرض الأقدم','Show older')}</button>}</div>;
}
