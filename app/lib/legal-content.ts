import {getPool} from './database';
import {getFirestoreDb,isFirestorePersistence} from './firestore-db';

export interface PlatformLegalSettings{
 company:string;
 support:string;
 terms:string;
 privacy:string;
}

const EMPTY_LEGAL:PlatformLegalSettings={company:'GymEG',support:'',terms:'',privacy:''};

export async function getPlatformLegalSettings():Promise<PlatformLegalSettings>{
 try{
  if(isFirestorePersistence()){
   const snap=await getFirestoreDb().collection('platform_settings').doc('1').get();
   if(!snap.exists)return EMPTY_LEGAL;
   const d=snap.data() as {payload?:Partial<PlatformLegalSettings>}|undefined;
   const p=d?.payload;
   return{
    company:typeof p?.company==='string'&&p.company.trim()?p.company.trim():'GymEG',
    support:typeof p?.support==='string'?p.support.trim():'',
    terms:typeof p?.terms==='string'?p.terms.trim():'',
    privacy:typeof p?.privacy==='string'?p.privacy.trim():'',
   };
  }
  const res=await getPool().query('SELECT payload FROM gymos.platform_settings WHERE id=1');
  const p=(res.rows[0]?.payload??{}) as Partial<PlatformLegalSettings>;
  return{
   company:typeof p.company==='string'&&p.company.trim()?p.company.trim():'GymEG',
   support:typeof p.support==='string'?p.support.trim():'',
   terms:typeof p.terms==='string'?p.terms.trim():'',
   privacy:typeof p.privacy==='string'?p.privacy.trim():'',
  };
 }catch{
  return EMPTY_LEGAL;
 }
}

export interface LegalSection{arTitle:string;enTitle:string;arBody:string;enBody:string;}

export const DEFAULT_TERMS_SECTIONS:LegalSection[]=[
 {
  arTitle:'١. نطاق الخدمة',
  enTitle:'1. Scope of Service',
  arBody:'تقدّم منصة GymEG نظامًا سحابيًا لإدارة الجيمات والنوادي الرياضية (عبر الويب، وتطبيق Windows، وتطبيقات Android للإدارة والأعضاء والدعم) يشمل تسجيل الأعضاء، الاشتراكات، الحضور، التحصيل، التدريب، والمخزون.',
  enBody:'GymEG provides a cloud-based gym and fitness club management platform (via Web, Windows desktop, and Android apps for management, members, and support) covering member records, memberships, attendance, collections, training, and inventory.'
 },
 {
  arTitle:'٢. التجربة المجانية والتفعيل المدفوع',
  enTitle:'2. Free Trial & Paid Activation',
  arBody:'تتوفر فترة تجربة مجانية لمدة ٣٠ يومًا للأندية الجديدة المؤهلة. بعد انتهاء التجربة، يتم التفعيل المدفوع والصيانة والدعم الفني وفق الاتفاق المباشر ومراجعة التحويل من قِبل إدارة المنصة.',
  enBody:'Eligible new clubs receive a 30-day free trial. After the trial, paid activation, maintenance, and technical support are provided by direct agreement and transfer verification with GymEG administration.'
 },
 {
  arTitle:'٣. مسؤولية النادي والبيانات',
  enTitle:'3. Club Responsibility & Data Ownership',
  arBody:'كل نادٍ يمتلك مساحة بيانات مستقلة وهو المسؤول عن صحة بيانات أعضائه، وصلاحيات فريق العمل، والالتزام باللوائح المحلية عند تفعيل ميزات اختيارية مثل التعرف على الوجه أو رسائل واتساب/SMS.',
  enBody:'Each club operates an isolated workspace and is responsible for the accuracy of its member records, staff permissions, and local legal compliance when enabling optional features such as face recognition or WhatsApp/SMS messaging.'
 },
 {
  arTitle:'٤. الاستخدام المقبول والأمان',
  enTitle:'4. Acceptable Use & Security',
  arBody:'يُحظر محاولة الوصول غير المصرح به إلى بيانات أندية أخرى، أو إساءة استخدام واجهات البرمجة، أو مشاركة حسابات المالكين. يحق لإدارة المنصة تعليق الحسابات المخالفة أو المنتهية اشتراكاتها وفق السياسة المعلنة.',
  enBody:'Unauthorized access to other clubs’ data, API abuse, or sharing owner credentials is prohibited. Platform administration may suspend accounts that violate these terms or have expired licenses.'
 },
 {
  arTitle:'٥. التعديلات والدعم',
  enTitle:'5. Updates & Support',
  arBody:'قد تقوم إدارة GymEG بتحديث هذه الشروط أو خصائص النظام لتحسين الأمان والأداء. يمكنك التواصل مع الدعم الفني عبر صفحة طلبات الدعم أو قنوات التواصل المعتمدة لدى المنصة.',
  enBody:'GymEG may update these terms or system features to improve security and reliability. You can reach support through the support-requests portal or official platform contact channels.'
 }
];

export const DEFAULT_PRIVACY_SECTIONS:LegalSection[]=[
 {
  arTitle:'١. البيانات التي يتم جمعها',
  enTitle:'1. Data We Collect',
  arBody:'نجمع بيانات حسابات الإدارة (الاسم، البريد الإلكتروني، الدور، الفروع)، وبيانات أعضاء النادي التي يسجلها النادي (الاسم، رقم الهاتف، الاشتراك، الحضور، المدفوعات، القياسات، والصور أو بصمة الوجه الاختيارية بموافقة العضو)، إضافةً إلى رموز الإشعارات (FCM / Web Push) عند تفعيلها.',
  enBody:'We process staff account details (name, email, role, branches), member records entered by the club (name, phone, memberships, attendance, payments, measurements, and optional photos/face templates with member consent), and push notification tokens (FCM / Web Push) when enabled.'
 },
 {
  arTitle:'٢. كيفية استخدام البيانات',
  enTitle:'2. How We Use Data',
  arBody:'تُستخدم البيانات حصرًا لتشغيل خدمات إدارة النادي، وبوابة العضو، وتسجيل الحضور، وإرسال التنبيهات المطلوبة، وحماية الحسابات ومنع الاحتيال. لا تقوم GymEG ببيع البيانات الشخصية لأي طرف ثالث.',
  enBody:'Data is used strictly to operate club management, the member portal, attendance tracking, requested notifications, and account security/fraud prevention. GymEG never sells personal data to third parties.'
 },
 {
  arTitle:'٣. عزل البيانات وأمانها',
  enTitle:'3. Data Isolation & Security',
  arBody:'بيانات كل نادٍ معزولة منطقيًا حسب معرّف النادي، وتُشفّر الاتصالات عبر HTTPS، كما تُحفظ كلمات المرور وأسرار التكامل باستخدام آليات تجزئة وتشفير معتمدة.',
  enBody:'Each club’s data is logically isolated by tenant ID. All traffic is encrypted over HTTPS, and passwords and integration secrets are stored using industry-standard hashing and encryption.'
 },
 {
  arTitle:'٤. الأذونات في تطبيقات الموبايل',
  enTitle:'4. Mobile App Permissions',
  arBody:'قد تطلب تطبيقات Android إذن الكاميرا (لمسح كروت QR/الباركود أو التحقق بالوجه) وإذن الإشعارات (لتنبيهات الدعم والرسائل). تُستخدم هذه الأذونات داخل الوظيفة المحددة فقط.',
  enBody:'The Android apps may request Camera permission (for QR/barcode card scanning or face verification) and Notification permission (for support and message alerts). Permissions are used solely for those features.'
 },
 {
  arTitle:'٥. الاحتفاظ بالبيانات وحقوقك',
  enTitle:'5. Data Retention & Your Rights',
  arBody:'يحتفظ النادي ببياناته طوال فترة الاشتراك النشط ويمكنه تصديرها أو أرشفتها. للأعضاء حق طلب مراجعة بياناتهم أو تصحيحها أو حذفها عبر إدارة النادي التابعين له.',
  enBody:'Clubs retain their records while active and may export or archive them. Members may request access, correction, or deletion of their records through their club administration.'
 }
];
