import Link from 'next/link';
import Image from 'next/image';
import {headers} from 'next/headers';
import members from '../public/downloads/gymeg-members-android.json';
import management from '../public/downloads/gymeg-management-android.json';
import {resolveDeploymentOrigin,generateQrDataUrl} from './lib/support-release';
import './member-install/install.css';
export default async function MobileInstallGuide({kind,en=false}:{kind:'members'|'management';en?:boolean}){
 const member=kind==='members',release=member?members:management,home=member?'/member':'/clubs';
 const t=(ar:string,english:string)=>en?english:ar;
 const name=member?(en?'GymEG Members':'GymEG الأعضاء'):(en?'GymEG Manager':'GymEG إدارة النادي'),entry=member?'/mobile/member':'/mobile/management';
 const fallbackQr=member?'/downloads/gymeg-member-qr.png':'/downloads/gymeg-management-qr.png';
 const filename=release.url.split('/').pop()??(member?'GymEG-Members-Android.apk':'GymEG-Manager-Android.apk');
 const h=await headers(),host=h.get('x-forwarded-host')??h.get('host'),proto=h.get('x-forwarded-proto')?.split(',')[0]?.trim()||(host?.startsWith('localhost')||host?.startsWith('127.0.0.1')?'http':'https');
 const origin=resolveDeploymentOrigin(host?`${proto}://${host}`:null);
 const qrSrc=await generateQrDataUrl(new URL(entry,origin).toString(),fallbackQr);
 return <main className="mobile-install-guide" dir={en?'ltr':'rtl'}>
  <header><Link href="/">GymEG</Link><Link href={(member?'/member-install':'/management-install')+(en?'':'?lang=en')}>{en?'العربية':'English'}</Link></header>
  <section className="install-intro"><Image src={member?"/icons/members-192.png?v=20261030-role-icons":"/icons/icon-192.png?v=20261029-gymeg"} width={88} height={88} alt={name} unoptimized style={{borderRadius:20,display:'block',margin:'0 auto 16px',boxShadow:'0 6px 18px rgba(0,0,0,0.18)'}}/><small>YOUR GYM. ONE SYSTEM.</small><h1>{name}</h1><p>{t('التطبيق الجديد، بنفس حسابك وبياناتك الحالية.','Your new app, with your existing account and records.')}</p><Link className="button secondary" href={home}>{t('فتح نسخة الويب','Open web app')}</Link></section>
  <div className="install-platforms"><section className="card"><h2>Android</h2>
   <a href={entry}><Image src={qrSrc} width={180} height={180} alt={t('QR تحميل التطبيق','App download QR')} unoptimized/></a>
   <a className="button primary" href={release.url} download={filename}>{t('تحميل '+name+' — Android ('+release.version+')','Download '+name+' — Android ('+release.version+')')}</a>
   <a className="button secondary" href={member?'/manuals/GymEG_Members_Mobile_AR_EN.pdf':'/manuals/GymEG_Club_Manager_AR_EN.pdf'} download>{t('دليل الاستخدام PDF','Operating guide PDF')}</a>
   <p>{t('الإصدار','Version')} {release.version} · Android {release.minAndroid}+ · {t('يتطلب الإنترنت','Internet required')}</p>
   <ol><li>{t('حمّل التطبيق وافتحه، ثم اسمح بالتثبيت إذا طلب Android ذلك.','Download and open the app, then allow installation if Android asks.')}</li><li>{t('سجّل بنفس حسابك الحالي.','Sign in with your existing account.')}</li><li>{member?t('استخدم رقم الهاتف والرقم السري المسجلين لدى النادي.','Use the phone number and PIN registered with your club.'):t('يمكنك السماح باستخدام الكاميرا لمسح الكروت.','Allow camera access to scan membership cards.')}</li></ol>
  </section><section className="card"><h2>iPhone / iPad</h2><ol><li>{t('افتح نسخة الويب في Safari.','Open the web app in Safari.')}</li><li>{t('اختر مشاركة ← إضافة إلى الشاشة الرئيسية ← إضافة.','Choose Share → Add to Home Screen → Add.')}</li><li>{t('افتح التطبيق من الشاشة الرئيسية وسجّل الدخول.','Open the app from your Home Screen and sign in.')}</li></ol><Link className="button primary" href={home}>{t('فتح التطبيق','Open app')}</Link></section></div>
 <footer style={{textAlign:'center',marginTop:'24px',display:'flex',gap:'16px',justifyContent:'center',flexWrap:'wrap',fontSize:'0.9rem'}}><Link href={'/terms'+(en?'?lang=en':'')}>{t('شروط الخدمة','Terms of Service')}</Link><Link href={'/privacy'+(en?'?lang=en':'')}>{t('سياسة الخصوصية','Privacy Policy')}</Link></footer>
 </main>;
}
