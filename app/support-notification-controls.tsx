'use client';
import {useState} from 'react';
import {requestNotificationPermission,disablePushNotifications} from './lib/platform-alerts';

export default function SupportNotificationControls({ar}:{ar:boolean}){
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const t=(a:string,e:string)=>ar?a:e;
 async function enable(){
  if(busy)return;setBusy(true);
  try{
   const result=await requestNotificationPermission(undefined,'support');
   setNotice(result.remote?t('تم تسجيل الجهاز لتنبيهات فتح وإنهاء جلسات الدعم.','This device is registered for support session alerts.'):
    result.prompted?t('اختر السماح بإشعارات Android ثم اضغط تفعيل تنبيهات الدعم مرة أخرى.','Allow Android notifications, then tap Enable support alerts again.'):
    !result.granted?t('اسمح بإشعارات GymEG Support من إعدادات الجهاز ثم أعد التفعيل.','Allow GymEG Support notifications in device settings, then enable again.'):
    !result.configured?t('إعداد تنبيهات الدعم بالخادم غير مكتمل. لم يتم تسجيل الجهاز.','Server support alerts are not configured. This device was not registered.'):
    t('تعذر تسجيل الجهاز. تحقق من الاتصال ثم أعد المحاولة.','Could not register this device. Check the connection and retry.'));
  }catch{setNotice(t('تعذر تسجيل الجهاز. أعد المحاولة.','Could not register this device. Retry.'));}finally{setBusy(false);}
 }
 async function disable(){
  if(busy)return;setBusy(true);
  try{const ok=await disablePushNotifications(undefined,'support');setNotice(ok?t('تم إيقاف تنبيهات الدعم لهذا الجهاز.','Support alerts are disabled for this device.'):t('تعذر إيقاف تنبيهات الدعم. أعد المحاولة.','Could not disable support alerts. Retry.'));}
  catch{setNotice(t('تعذر إيقاف تنبيهات الدعم. أعد المحاولة.','Could not disable support alerts. Retry.'));}finally{setBusy(false);}
 }
 return <section aria-label={t('تنبيهات الدعم','Support alerts')} className="commercial-support-notifications" style={{marginBlock:'1rem'}}>
  <button className="button secondary" disabled={busy} onClick={()=>void enable()}>{t('تفعيل تنبيهات الدعم','Enable support alerts')}</button>{' '}
  <button className="quiet" disabled={busy} onClick={()=>void disable()}>{t('إيقاف تنبيهات الدعم','Disable support alerts')}</button>
  {notice&&<p role="status">{notice}</p>}
 </section>;
}
