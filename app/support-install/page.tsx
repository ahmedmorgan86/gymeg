import Link from 'next/link';
import Image from 'next/image';
import {headers} from 'next/headers';
import {redirect,notFound} from 'next/navigation';
import {getChatGPTUser} from '../chatgpt-auth';
import {commercialTransaction} from '../lib/commercial';
import {supportApkFilename,supportApkUrl,supportApkVersion,supportFallbackQrPath,supportMinAndroid,resolveSupportApkUrl,generateQrDataUrl} from '../lib/support-release';
import '../member-install/install.css';
export const dynamic='force-dynamic';
export const metadata={title:'GymEG Support — تطبيق الموبايل',robots:{index:false,follow:false},manifest:'/support.webmanifest',appleWebApp:{capable:true,title:'GymEG الدعم الفني',statusBarStyle:'default' as const},icons:{icon:'/icons/support-192.png?v=20261030-role-icons',apple:'/icons/support-180.png?v=20261030-role-icons'}};
export default async function Page(){
 const u=await getChatGPTUser();
 if(!u)redirect('/support-login');
 if(!await commercialTransaction(u,async(_c,p)=>p))notFound();
 const h=await headers(),host=h.get('x-forwarded-host')??h.get('host'),proto=h.get('x-forwarded-proto')?.split(',')[0]?.trim()||(host?.startsWith('localhost')||host?.startsWith('127.0.0.1')?'http':'https');
 const fullApkUrl=resolveSupportApkUrl(host?`${proto}://${host}`:null);
 const qrSrc=await generateQrDataUrl(fullApkUrl,supportFallbackQrPath);
 return <main className="mobile-install-guide" dir="rtl"><header><Link href="/platform" style={{display:'inline-flex',alignItems:'center',gap:10}}><Image src="/icons/support-192.png?v=20261030-role-icons" width={36} height={36} alt="GymEG Support" unoptimized style={{borderRadius:8}}/><span>GymEG SUPPORT</span></Link><Link href="/sign-out">تسجيل الخروج</Link></header><section className="install-intro"><Image src="/icons/support-192.png?v=20261030-role-icons" width={96} height={96} alt="GymEG Support" unoptimized style={{borderRadius:22,display:'block',marginBottom:16}}/><h1>إدارة منصتك، معاك على الموبايل.</h1><p>تطبيق خاص بحساب صاحب المنصة فقط. نفس الحساب والصلاحيات والتحقق من الخادم، بدون أي مفاتيح إدارية داخل التطبيق.</p><Link className="button secondary" href="/platform">فتح إدارة المنصة على الويب</Link></section><div className="install-platforms"><section className="card"><h2>Android</h2><a href={supportApkUrl} download={supportApkFilename}><Image src={qrSrc} width={180} height={180} alt="QR تطبيق الدعم" unoptimized/></a><a className="button primary" href={supportApkUrl} download={supportApkFilename}>تحميل تطبيق الدعم — Android ({supportApkVersion})</a><p>الإصدار {supportApkVersion} · Android {supportMinAndroid}+ · يتطلب الإنترنت</p><ol><li>حمّل ملف APK وافتحه على هاتف Android، ثم اسمح بالتثبيت.</li><li>سجّل الدخول بحساب صاحب المنصة لإدارة الأندية والتراخيص والنداءات الصوتية.</li></ol></section><section className="card"><h2>iPhone / iPad</h2><p>افتح هذه الصفحة في Safari، ثم مشاركة ← إضافة إلى الشاشة الرئيسية ← إضافة. نسخة iPhone تطبيق ويب قابل للتثبيت، وليست ملف iOS أو إصدار App Store.</p><Link className="button primary" href="/platform">فتح إدارة المنصة</Link><p>تطبيق الويب يتصل بالنظام مباشرة. يتطلب اتصالًا بالإنترنت.</p></section></div></main>;
}
