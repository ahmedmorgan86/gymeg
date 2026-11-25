import Link from 'next/link';
import {DEFAULT_PRIVACY_SECTIONS,DEFAULT_TERMS_SECTIONS,getPlatformLegalSettings} from './lib/legal-content';
import './member-install/install.css';

export default async function LegalPage({kind,en=false}:{kind:'terms'|'privacy';en?:boolean}){
 const settings=await getPlatformLegalSettings();
 const isTerms=kind==='terms';
 const t=(ar:string,english:string)=>en?english:ar;
 const customText=isTerms?settings.terms:settings.privacy;
 const sections=isTerms?DEFAULT_TERMS_SECTIONS:DEFAULT_PRIVACY_SECTIONS;
 const title=isTerms?t('شروط الخدمة','Terms of Service'):t('سياسة الخصوصية','Privacy Policy');
 const otherHref=(isTerms?'/terms':'/privacy')+(en?'':'?lang=en');
 return <main className="mobile-install-guide" dir={en?'ltr':'rtl'} lang={en?'en':'ar'}>
  <header>
   <Link href={en?'/en/about':'/'}>{settings.company||'GymEG'}</Link>
   <div style={{display:'flex',gap:'12px',alignItems:'center'}}>
    <Link href={(isTerms?'/privacy':'/terms')+(en?'?lang=en':'')}>{isTerms?t('سياسة الخصوصية','Privacy Policy'):t('شروط الخدمة','Terms of Service')}</Link>
    <Link href={otherHref}>{en?'العربية':'English'}</Link>
   </div>
  </header>
  <section className="install-intro" style={{textAlign:en?'left':'right',maxWidth:'820px',margin:'0 auto 24px'}}>
   <small>GymEG · {t('الوثائق القانونية','LEGAL')}</small>
   <h1>{title}</h1>
   <p>{t('آخر تحديث: 26 نوفمبر 2026 · تطبق على منصة GymEG وتطبيقات الويب وWindows وAndroid.','Last updated: 26 Nov 2026 · Applies to the GymEG platform, Web, Windows, and Android apps.')}</p>
   {settings.support&&<p><strong>{t('جهة الدعم:','Support contact:')}</strong> {settings.support}</p>}
  </section>
  <div style={{maxWidth:'820px',margin:'0 auto',display:'grid',gap:'16px'}}>
   {customText&&<section className="card">
    <h2>{t('سياسة إدارة المنصة المعتمدة','Platform Administration Policy')}</h2>
    <p style={{whiteSpace:'pre-wrap',lineHeight:1.7}}>{customText}</p>
   </section>}
   {sections.map(s=><section className="card" key={s.enTitle}>
    <h2>{en?s.enTitle:s.arTitle}</h2>
    <p style={{lineHeight:1.75}}>{en?s.enBody:s.arBody}</p>
   </section>)}
   <div style={{display:'flex',gap:'12px',flexWrap:'wrap',justifyContent:'center',marginTop:'8px'}}>
    <Link className="button secondary" href={en?'/en/about':'/'}>{t('العودة للموقع الرئيسي','Back to main website')}</Link>
    <Link className="button secondary" href="/sign-in">{t('تسجيل الدخول','Sign in')}</Link>
    <Link className="button secondary" href="/member">{t('دخول العضو','Member sign-in')}</Link>
   </div>
  </div>
 </main>;
}
