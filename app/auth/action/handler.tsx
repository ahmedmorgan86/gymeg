"use client";
import {useSearchParams} from 'next/navigation';
import {useEffect,useState} from 'react';
import Copyright from '../../copyright';

type State='loading'|'ready'|'done'|'error';

export default function ActionHandler(){
 const params=useSearchParams();
 const mode=params.get('mode')??'';
 const oobCode=params.get('oobCode')??'';
 const [ar,setAr]=useState(true),[state,setState]=useState<State>('loading'),[email,setEmail]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const t=(a:string,b:string)=>ar?a:b;
 const isVerify=mode==='verifyEmail';
 const isReset=mode==='resetPassword';
 useEffect(()=>{
  const run=async()=>{
   if(!oobCode||(!isReset&&!isVerify)){setState('error');setMessage('');return;}
   try{
    const r=await fetch('/api/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(isVerify?{action:'verify-email',oobCode}:{action:'reset-info',oobCode})});
    if(r.ok){
     if(isVerify){setState('done');setMessage(t('تم تأكيد بريدك الإلكتروني. يمكنك تسجيل الدخول الآن.','Your email is confirmed. You can sign in now.'));}
     else{const d=await r.json() as {email?:string};setEmail(d.email??'');setState('ready');}
    }else setState('error');
   }catch{setState('error');}
  };
  void run();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[mode,oobCode]);
 const invalidLink=t('الرابط غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.','This link is invalid or expired. Request a fresh one.');
 return <main className="auth-shell" dir={ar?'rtl':'ltr'}><section className="auth-card"><button onClick={()=>setAr(!ar)}>{ar?'EN':'ع'}</button><p className="eyebrow">GymEG</p>
  <h1>{isVerify?t('تأكيد البريد الإلكتروني','Confirm email'):t('كلمة مرور جديدة','New password')}</h1>
  {state==='loading'&&<p role="status">{t('جارٍ التحقق من الرابط…','Checking the link…')}</p>}
  {state==='error'&&<><p role="alert">{message||invalidLink}</p><a href="/forgot-password">{t('طلب رابط جديد','Request a fresh link')}</a></>}
  {state==='done'&&<><p role="status">{message}</p><a href="/sign-in">{t('تسجيل الدخول','Sign in')}</a></>}
  {state==='ready'&&<form onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);if(f.get('password')!==f.get('confirm')){setMessage(t('كلمتا المرور غير متطابقتين.','Passwords do not match.'));return;}setBusy(true);setMessage('');try{const r=await fetch('/api/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'reset-confirm',oobCode,password:f.get('password')})});if(!r.ok){setMessage(r.status===429?t('انتظر قليلًا قبل المحاولة مجددًا.','Wait before trying again.'):invalidLink);return;}setState('done');setMessage(t('تم تغيير كلمة المرور. يمكنك تسجيل الدخول الآن.','Password updated. You can sign in now.'));}catch{setMessage(t('تعذر الاتصال.','Connection failed.'));}finally{setBusy(false);}}}>
   {email&&<p>{email}</p>}
   <label>{t('كلمة المرور الجديدة — ١٢ حرفًا على الأقل','New password — at least 12 characters')}<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required/></label>
   <label>{t('تأكيد كلمة المرور','Confirm password')}<input name="confirm" type="password" minLength={12} maxLength={128} autoComplete="new-password" required/></label>
   <p role="status">{message}</p>
   <button className="button primary" disabled={busy}>{busy?t('جارٍ الحفظ…','Saving…'):t('حفظ كلمة المرور','Save password')}</button>
  </form>}
 </section><footer className="ownership-footer"><Copyright/></footer></main>;
}
