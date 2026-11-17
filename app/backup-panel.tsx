"use client";
import TaskPanels from './task-panels';
import {useEffect,useState} from 'react';
import {downloadBackupText,restoreBackup} from './lib/backup-client';
type AlertDialogModule=typeof import('../components/ui/alert-dialog');
export default function BackupPanel({owner,revision,ar,reload}:{owner:string;revision:number;ar:boolean;reload:()=>Promise<void>}){
 const[backup,setBackup]=useState<{name:string;data:unknown;members:number}|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[restoreOpen,setRestoreOpen]=useState(false),[restoreCode,setRestoreCode]=useState(''),[alerts,setAlerts]=useState<AlertDialogModule|null>(null);
 const t=(a:string,e:string)=>ar?a:e;
 useEffect(()=>{if(!restoreOpen||alerts)return;let live=true;void import('../components/ui/alert-dialog').then(m=>{if(live)setAlerts(m);});return()=>{live=false};},[restoreOpen,alerts]);
 async function download(){const text=await downloadBackupText(owner),url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='GymEG-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 async function runRestore(){if(!backup)return;setBusy(true);try{await download();await restoreBackup(owner,backup.data,revision);await reload();setBackup(null);setMessage(t('تمت الاستعادة','Backup restored'));}catch{setMessage(t('تعذر تأكيد نتيجة الاستعادة. حدّث البيانات قبل إعادة المحاولة فقد تكون اكتملت.','Restore result unconfirmed. Refresh before retrying; it may already have completed.'));}finally{setBusy(false);}}
 function closeRestore(){setRestoreOpen(false);setRestoreCode('');}
 return <section className="feature-panel card"><h2>{t('نسخة GymEG الكاملة والنسخ الخارجية','Full GymEG backups & external files')}</h2>
<p>{t('استعادة نسخة GymEG تستبدل بيانات التشغيل الحالية بعد حفظ نقطة استرجاع على الخادم. لاستيراد بيانات برنامج آخر دون استبدال استخدم قسم الاستيراد أدناه. لا تشمل النسخة كلمات المرور أو مفاتيح واتساب أو قوالب التعرف على الوجه.','Restoring a GymEG backup replaces current business data after a server recovery snapshot is saved. To import another program without replacing data, use the importer below. Backups exclude passwords, WhatsApp credentials and face templates.')}</p>
<TaskPanels ar={ar} labels={[t("تنزيل نسخة احتياطية","Download a backup"),t("استعادة نسخة سابقة","Restore a backup")]}><div className="task-content"><button className="button primary" disabled={busy} onClick={async()=>{setBusy(true);try{await download();setMessage(t('تم تجهيز وتنزيل النسخة','Backup prepared and downloaded'));}catch{setMessage(t('تعذر تنزيل النسخة','Backup download failed'));}finally{setBusy(false);}}}>{t('تنزيل نسخة احتياطية كاملة','Download full backup')}</button></div>
<div className="task-content"><label>{t('رفع نسخة GymEG من جهاز أو استضافة سابقة — JSON حتى 64 MB','Upload GymEG backup from another device/host — JSON up to 64 MB')}<input type="file" accept=".json,application/json" disabled={busy} onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{if(f.size>64*1024*1024)throw Error();const data=JSON.parse(await f.text());if(data.format!=='gymos-backup'||!Array.isArray(data.state?.members))throw Error();setBackup({name:f.name,data,members:data.state.members.length});setMessage('');}catch{setBackup(null);setMessage(t('هذا ليس ملف نسخة GymEG صالحة. لبرنامج آخر استخدم Excel/CSV/JSON بالجداول أدناه.','Not a valid GymEG backup. For another program, use exported Excel/CSV/JSON tables below.'));}}}/></label>
{backup&&<><p>{backup.name} · {backup.members} {t('عضو','members')}</p><button className="button secondary" disabled={busy} onClick={()=>{setRestoreCode('');setRestoreOpen(true);}}>{t('استعادة بعد تنزيل نسخة البيانات الحالية','Restore after downloading current data')}</button></>}</div></TaskPanels>

{restoreOpen&&alerts&&(()=>{
 const {AlertDialog,AlertDialogContent,AlertDialogHeader,AlertDialogFooter,AlertDialogTitle,AlertDialogDescription,AlertDialogCancel,AlertDialogAction}=alerts;
 return <AlertDialog open onOpenChange={open=>{if(!open)closeRestore();}}>
  <AlertDialogContent dir={ar?'rtl':'ltr'} lang={ar?'ar':'en'} onOpenAutoFocus={e=>{e.preventDefault();(e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('[data-gymos-restore-code]')?.focus();}}>
   <AlertDialogHeader>
    <AlertDialogTitle>{t('تأكيد استعادة النسخة الاحتياطية','Confirm backup restore')}</AlertDialogTitle>
    <AlertDialogDescription>{t('سيتم استبدال بيانات النادي. اكتب RESTORE للتأكيد','Club data will be replaced. Type RESTORE to confirm')}</AlertDialogDescription>
   </AlertDialogHeader>
   <label>{t('اكتب RESTORE للتأكيد','Type RESTORE to confirm')}<input data-gymos-restore-code value={restoreCode} onChange={e=>setRestoreCode(e.target.value)} autoComplete="off" dir="ltr" aria-describedby="gymos-restore-help"/></label>
   <p id="gymos-restore-help" className="form-note">{t('لا يمكن التراجع عن الاستعادة بعد بدئها؛ تُحفظ نقطة استرجاع على الخادم أولًا.','Restore cannot be undone once started; a server recovery snapshot is saved first.')}</p>
   <AlertDialogFooter>
    <AlertDialogCancel onClick={closeRestore}>{t('إلغاء','Cancel')}</AlertDialogCancel>
    <AlertDialogAction disabled={restoreCode!=='RESTORE'} onClick={()=>{closeRestore();void runRestore();}}>{t('استعادة النسخة','Restore backup')}</AlertDialogAction>
   </AlertDialogFooter>
  </AlertDialogContent>
 </AlertDialog>;
})()}

{message&&<p role="status">{message}</p>}</section>;
}
