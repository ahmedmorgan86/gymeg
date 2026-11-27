import {z} from 'zod';
import {RuleError,dayAt,days,type GymState,type Member,type Operation} from './domain.ts';
import {normalizeMemberPhone} from './member-phone-format.ts';
import {invoiceOutstanding} from './member-ledger.ts';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v);
export const manualTemplateSchema=z.object({id:z.string().min(1).max(250),branch:z.string().min(1).max(250),name:z.string().trim().min(1).max(100),kind:z.enum(['welcome','policy','birthday','occasion','absence','renewal','expired']),body:z.string().trim().min(1).max(1500).refine(v=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)),enabled:z.boolean(),offset:z.number().int().min(1).max(90),date:date.optional()}).strict().refine(x=>x.kind!=='occasion'||Boolean(x.date));
export const manualWhatsAppSchema=z.array(manualTemplateSchema).max(100);
export type ManualWhatsAppTemplate=z.infer<typeof manualTemplateSchema>;
export type WhatsAppPresetCategory='statuses'|'religious'|'holidays'|'offers';
export interface WhatsAppTemplatePreset{
  id:string;
  category:WhatsAppPresetCategory;
  kind:ManualWhatsAppTemplate['kind'];
  titleAr:string;
  titleEn:string;
  bodyAr:string;
  bodyEn:string;
  offset:number;
}
export const WHATSAPP_TEMPLATE_PRESETS:WhatsAppTemplatePreset[]=[
  // --- Member Statuses ---
  {
    id:'status-welcome-inbody',
    category:'statuses',
    kind:'welcome',
    titleAr:'ترحيب بعضو جديد + قياس InBody',
    titleEn:'Welcome New Member + InBody',
    bodyAr:'أهلاً بك يا {name} في أسرة {gym} ({branch})! 💪\nسعداء جداً بانضمامك إلينا. توجه للاستقبال لحجز أول قياس InBody مجاني وخطة تدريب تناسب هدفك. اشتراكك سارٍ حتى {expires}. بالتوفيق!',
    bodyEn:'Welcome {name} to {gym} ({branch})! 💪\nWe are thrilled to have you with us. Visit reception to book your complimentary InBody scan and starter plan. Membership active until {expires}.',
    offset:7
  },
  {
    id:'status-policy-rules',
    category:'statuses',
    kind:'policy',
    titleAr:'إرشادات وقواعد النادي والسلامة',
    titleEn:'Club Guidelines & Safety Rules',
    bodyAr:'أهلاً {name}، نرحب بك في {gym}! 🏋️‍♂️\nللحفاظ على راحتك وسلامة الجميع: نرجو استخدام الفوطة الرياضية أثناء التمرين، إعادة الأوزان لمكانها بعد الاستخدام، وإبراز الكارت عند الدخول. فريقنا دائماً في خدمتك!',
    bodyEn:'Hello {name}, welcome to {gym}! 🏋️‍♂️\nTo keep everyone safe and comfortable: please bring a workout towel, re-rack weights after use, and scan your membership card at entry.',
    offset:7
  },
  {
    id:'status-renewal-7d',
    category:'statuses',
    kind:'renewal',
    titleAr:'تذكير قرب انتهاء الاشتراك (قبل 7 أيام)',
    titleEn:'Membership Renewal Reminder (7 Days)',
    bodyAr:'أهلاً {name}، نذكرك بأن اشتراكك في {gym} ينتهي بتاريخ {expires}. ⏳\nجدّد اشتراكك الآن في فرع {branch} للحفاظ على مستواك والاستفادة من باقات التجديد المتاحة بدون انقطاع!',
    bodyEn:'Hi {name}, friendly reminder that your {gym} membership expires on {expires}. ⏳\nRenew at {branch} today to keep your training streak going!',
    offset:7
  },
  {
    id:'status-renewal-48h',
    category:'statuses',
    kind:'renewal',
    titleAr:'تنبيه عاجل: تبقى يومان على انتهاء الاشتراك',
    titleEn:'Urgent: 48h Left Before Expiry',
    bodyAr:'كابتن {name}، يتبقى يومان فقط على انتهاء اشتراكك في {gym} (تاريخ الانتهاء: {expires}). 🔥\nتواصل معنا أو زر الاستقبال لتجديد باقتك قبل التوقف ومواصلة فورمتك!',
    bodyEn:'Hey {name}, only 2 days left before your {gym} membership ends on {expires}. 🔥\nRenew now to avoid any interruption to your workouts!',
    offset:2
  },
  {
    id:'status-expired-comeback',
    category:'statuses',
    kind:'expired',
    titleAr:'إشعار انتهاء الاشتراك والدعوة للتجديد',
    titleEn:'Expired Membership Follow-up',
    bodyAr:'أهلاً {name}، انتهت صلاحية اشتراكك في {gym} بتاريخ {expires}. 📅\nلا تدع حماسك يتوقف؛ يسعدنا استقبالك في فرع {branch} لتجديد عضويتك ومتابعة أهدافك الرياضية معنا!',
    bodyEn:'Hi {name}, your {gym} membership expired on {expires}. 📅\nDon’t pause your progress — visit {branch} anytime to renew and jump back in!',
    offset:7
  },
  {
    id:'status-absence-7d',
    category:'statuses',
    kind:'absence',
    titleAr:'رسالة افتقاد ومتابعة الغياب (7 أيام)',
    titleEn:'Attendance Gap Check-in (7 Days)',
    bodyAr:'وحشتنا في {gym} يا {name}! 💪\nلاحظنا غيابك عن التمرين خلال الفترة الماضية وحبينا نطمئن عليك. الاستمرارية هي سر النتائج — مستنيين رجوعك القوية لصالة التمرين في {branch}!',
    bodyEn:'We miss you at {gym}, {name}! 💪\nWe noticed you’ve been away from training lately and wanted to check in. Consistency wins — see you back at {branch} soon!',
    offset:7
  },
  {
    id:'status-birthday-gift',
    category:'statuses',
    kind:'birthday',
    titleAr:'تهنئة عيد ميلاد العضو',
    titleEn:'Member Birthday Wishes',
    bodyAr:'كل عام وأنت بألف صحة وسعادة يا {name}! 🎂🎉\nأسرة {gym} تتمنى لك عاماً جديداً مليئاً بالنشاط والقوة وتحقيق كل أهدافك الرياضية!',
    bodyEn:'Happy Birthday {name}! 🎂🎉\nThe {gym} team wishes you a fantastic year full of health, strength, and new personal records!',
    offset:1
  },
  // --- Religious Occasions ---
  {
    id:'rel-ramadan',
    category:'religious',
    kind:'occasion',
    titleAr:'تهنئة شهر رمضان المبارك + مواعيد التمرين',
    titleEn:'Ramadan Kareem Greetings',
    bodyAr:'رمضان كريم يا {name}! 🌙✨\nتتقدم أسرة {gym} بأطيب التهاني بمناسبة شهر رمضان المبارك، أعاده الله عليكم بالخير واليمن والبركات.\nنذكركم بأن صالة {branch} جاهزة لاستقبالكم قبل وبعد الإفطار للحفاظ على لياقتكم طوال الشهر الكريم!',
    bodyEn:'Ramadan Kareem, {name}! 🌙✨\nWishing you and your family peace, health, and blessings from everyone at {gym}. Stay consistent with our flexible Ramadan workout hours at {branch}!',
    offset:1
  },
  {
    id:'rel-eid-fitr',
    category:'religious',
    kind:'occasion',
    titleAr:'تهنئة عيد الفطر المبارك',
    titleEn:'Eid Al-Fitr Mubarak',
    bodyAr:'عيد فطر مبارك يا {name}! 🎊🌙\nأسرة {gym} تهنئكم بحلول عيد الفطر المبارك، تقبل الله طاعتكم وأدام عليكم الصحة والسعادة. ننتظركم بعد العيد لنشاط أقوى!',
    bodyEn:'Eid Al-Fitr Mubarak, {name}! 🎊🌙\nWarmest wishes from {gym} for a joyful Eid filled with health, happiness, and renewed energy!',
    offset:1
  },
  {
    id:'rel-eid-adha',
    category:'religious',
    kind:'occasion',
    titleAr:'تهنئة عيد الأضحى المبارك',
    titleEn:'Eid Al-Adha Mubarak',
    bodyAr:'كل عام وأنت بخير يا {name} بمناسبة عيد الأضحى المبارك! 🐑✨\nفريق {gym} يتمنى لك ولأسرتك الكريمة عيداً سعيداً وأياماً مليئة بالصحة والعافية.',
    bodyEn:'Eid Al-Adha Mubarak, {name}! 🐑✨\nWishing you and your loved ones a blessed, joyful Eid full of health and strength from {gym}.',
    offset:1
  },
  {
    id:'rel-hijri-newyear',
    category:'religious',
    kind:'occasion',
    titleAr:'تهنئة رأس السنة الهجرية',
    titleEn:'Islamic New Year',
    bodyAr:'عام هجري سعيد ومبارك يا {name}! 🕌✨\nأسرة {gym} تتمنى لك عاماً جديداً مليئاً بالخير والبركة والصحة والعزيمة القوية.',
    bodyEn:'Happy Islamic New Year, {name}! 🕌✨\nWishing you a blessed year ahead filled with health, peace, and strength from {gym}.',
    offset:1
  },
  {
    id:'rel-mawlid',
    category:'religious',
    kind:'occasion',
    titleAr:'تهنئة المولد النبوي الشريف',
    titleEn:'Prophet Birthday (Al-Mawlid)',
    bodyAr:'كل عام وأنت بخير يا {name} بمناسبة ذكرى المولد النبوي الشريف! 🌿✨\nأعاده الله عليك وعلى أسرتك بالخير والصحة والسلامة — مع تحيات أسرة {gym}.',
    bodyEn:'Warm blessings to you, {name}, on the occasion of Al-Mawlid Al-Nabawi! 🌿✨\nWishing you health and peace from everyone at {gym}.',
    offset:1
  },
  // --- Holidays & General Occasions ---
  {
    id:'hol-newyear',
    category:'holidays',
    kind:'occasion',
    titleAr:'تحدي رأس السنة الميلادية',
    titleEn:'New Year Fitness Challenge',
    bodyAr:'سنة جديدة، فورمة جديدة يا {name}! 🎆💪\nأسرة {gym} تهنئك بالعام الجديد وتدعوك لبدء تحدي اللياقة من اليوم في فرع {branch}. كل عام وأنت بأفضل صحة!',
    bodyEn:'New Year, Stronger You, {name}! 🎆💪\nHappy New Year from {gym}! Let’s crush your fitness goals together at {branch}.',
    offset:1
  },
  {
    id:'hol-coptic-christmas',
    category:'holidays',
    kind:'occasion',
    titleAr:'تهنئة عيد الميلاد المجيد',
    titleEn:'Merry Christmas Greetings',
    bodyAr:'عيد ميلاد مجيد وكل عام وأنت بخير يا {name}! 🎄✨\nأسرة {gym} تتمنى لك ولعائلتك عيداً سعيداً مليئاً بالمحبة والصحة والنشاط.',
    bodyEn:'Merry Christmas, {name}! 🎄✨\nWishing you and your family joy, health, and wonderful holidays from {gym}.',
    offset:1
  },
  {
    id:'hol-mothers-day',
    category:'holidays',
    kind:'occasion',
    titleAr:'تهنئة عيد الأم',
    titleEn:'Mother’s Day Tribute',
    bodyAr:'كل عام وكل أمهاتنا بخير وصحة وسعادة! 💐❤️\nأسرة {gym} تهنئك يا {name} بمناسبة عيد الأم، ونتمنى لكم دوام الصحة والقوة.',
    bodyEn:'Happy Mother’s Day, {name}! 💐❤️\nWishing every mother health, happiness, and strength from the {gym} family.',
    offset:1
  },
  // --- Offers & Promotions ---
  {
    id:'offer-early-renewal',
    category:'offers',
    kind:'occasion',
    titleAr:'عرض التجديد المبكر للأعضاء',
    titleEn:'Early Renewal Special Offer',
    bodyAr:'عرض خاص لك يا {name}! 🔥\nلأنك من أبطال {gym}، جدّد اشتراكك قبل تاريخ {expires} واحصل على خصم خاص أو أيام إضافية مجانية على باقتك في {branch}. العرض لفترة محدودة!',
    bodyEn:'Special member offer for you, {name}! 🔥\nRenew your {gym} membership before {expires} and unlock an exclusive early-bird bonus at {branch}. Limited time!',
    offset:1
  },
  {
    id:'offer-refer-friend',
    category:'offers',
    kind:'occasion',
    titleAr:'عرض ادعُ صديقك للتمرين',
    titleEn:'Refer a Friend Bonus',
    bodyAr:'التمرين مع صحابك أحلى يا {name}! 🤝💪\nادعُ صديقك للاشتراك في {gym} ({branch}) واحصل أنت وهو على أيام إضافية مجانية أو جلسة تقييم InBody هدية!',
    bodyEn:'Training is better with friends, {name}! 🤝💪\nRefer a friend to {gym} ({branch}) and you both get bonus membership days or a free InBody session!',
    offset:1
  },
  {
    id:'offer-annual-vip',
    category:'offers',
    kind:'occasion',
    titleAr:'عرض الباقات السنوية ونصف السنوية',
    titleEn:'Annual & 6-Month VIP Offer',
    bodyAr:'وفّر أكثر مع الباقات الطويلة في {gym} يا {name}! 🏆\nاحجز الباقة نصف السنوية أو السنوية الآن بخصم مميز + متابعة قياسات دورية في فرع {branch}. اسأل الاستقبال عن التفاصيل!',
    bodyEn:'Save more with long-term plans at {gym}, {name}! 🏆\nUpgrade to our 6-month or annual package at {branch} with special savings + periodic InBody tracking!',
    offset:1
  },
  {
    id:'offer-pt-inbody',
    category:'offers',
    kind:'occasion',
    titleAr:'عرض باقات التدريب الشخصي (PT)',
    titleEn:'Personal Training (PT) Promo',
    bodyAr:'عايز نتائج أسرع وأدق يا {name}؟ 🎯💪\nاحجز باقة تدريب شخصي (PT) مع مدربي {gym} المعتمدين واحصل على خطة تغذية وتمارين مخصصة + قياس InBody مجاني!',
    bodyEn:'Ready for faster results, {name}? 🎯💪\nBook a Personal Training package at {gym} and get a tailored workout & nutrition plan plus a free InBody assessment!',
    offset:1
  },
  {
    id:'offer-winback',
    category:'offers',
    kind:'occasion',
    titleAr:'عرض العودة للأعضاء السابقين',
    titleEn:'Welcome Back Special Offer',
    bodyAr:'أهلاً بعودتك لأسرة {gym} يا {name}! 🚀\nجهّزنا لك عرض عودة خاص لتجديد اشتراكك في فرع {branch} بأفضل سعر. مستنيينك ترجع تبدأ من جديد بقوة!',
    bodyEn:'Welcome back to {gym}, {name}! 🚀\nWe prepared a special comeback offer for you at {branch}. Come restart your fitness journey stronger than ever!',
    offset:1
  }
];
export const defaultWhatsApp=(kind:ManualWhatsAppTemplate['kind'],ar:boolean)=>({
  welcome:ar
    ?'أهلًا بك يا {name} في أسرة {gym}! 💪 يسعدنا جدًا انضمامك لأسرتنا الرياضية، ونتمنى لك رحلة تدريبية موفقة وتحقيقًا لكل أهدافك. فريقنا والمدربون دائمًا في خدمتك لأي مساعدة.'
    :'Welcome {name} to the {gym} family! 💪 We are thrilled to have you with us and wish you an inspiring, successful fitness journey. Our team and coaches are always here to support you.',
  policy:ar
    ?'أهلًا {name}، إليك إرشادات وقواعد التدريب والسلامة العامة في {gym} لضمان أفضل تجربة لك ولجميع الأعضاء. نرجو الاطلاع عليها والالتزام بها، ويسعدنا الإجابة عن أي استفسار.'
    :'Hello {name}, here are the workout rules and gym safety guidelines for {gym} to ensure the best experience for everyone. Please review them, and feel free to ask our team any questions.',
  birthday:ar
    ?'كل عام وأنت بألف صحة وسعادة يا {name}! 🎉🎂 أسرة {gym} تتمنى لك عامًا جديدًا مليئًا بالنشاط والنجاح والوصول لأفضل لياقة وفورمة.'
    :'Happy Birthday {name}! 🎉🎂 The {gym} team wishes you a wonderful year full of strength, energy, and milestone fitness achievements!',
  occasion:ar
    ?'أهلًا {name}، تتقدم أسرة {gym} بأحر التهاني وأطيب التمنيات بمناسبة {occasion}! كل عام وأنت وأسرتك الكريمة بخير وصحة وعافية.'
    :'Hello {name}, warm greetings from {gym} on {occasion}! Wishing you and your loved ones joy, happiness, and good health.',
  absence:ar
    ?'وحشتنا في {gym} يا {name}! 💪 لاحظنا غيابك عن التمرين مؤخرًا وحبينا نطمئن عليك. تذكر أن الاستمرارية هي سر النتائج؛ بانتظار عودتك القوية لصالة التدريب، وإذا كنت بحاجة لأي استشارة نحن دائمًا معك.'
    :'We miss you at {gym}, {name}! 💪 We noticed you have been away from training lately and wanted to check in. Consistency is key to real results; we cannot wait to see you back on the gym floor!',
  renewal:ar
    ?'أهلًا {name}، نود تذكيرك بأن اشتراكك في {gym} ينتهي بتاريخ {expires}. تفضل بزيارة الاستقبال للتجديد الآن للحفاظ على استمرارية لياقتك والاستفادة من أفضل عروض الباقات المتاحة.'
    :'Hello {name}, friendly reminder that your membership at {gym} ends on {expires}. Visit our reception to renew today, keep your training momentum going, and enjoy our latest offers!',
  expired:ar
    ?'أهلًا {name}، نبلغك بأن اشتراكك في {gym} قد انتهى بتاريخ {expires}. لا تدع حماسك يتوقف؛ يسعدنا تجديد عضويتك وترحيبنا بك مجددًا في صالة التمرين في أي وقت لمواصلة فورمتك.'
    :'Hello {name}, your membership at {gym} expired on {expires}. Don\'t pause your progress! We would love to welcome you back anytime to renew and continue your fitness journey.'
}[kind]);
export function manualWhatsAppOperation(s:GymState,op:Operation,newId:()=>string){
 if(op.type!=='whatsapp.manual.save')return false;
 s.manualWhatsApp??=[];const old=op.id?s.manualWhatsApp.find(t=>t.id===op.id&&t.branch===op.branch):undefined;if(op.id&&!old)throw new RuleError('notFound');
 const row=manualTemplateSchema.parse({id:old?.id??newId(),branch:op.branch,name:op.name,kind:op.kind,body:op.body,enabled:op.enabled,offset:op.offset??7,...(op.date?{date:op.date}:{})});
 if(old)Object.assign(old,row);else s.manualWhatsApp.push(row);manualWhatsAppSchema.parse(s.manualWhatsApp);return true;
}
export const LEGACY_DUMMY_BODY = 'أهلًا {name}، معك فريق {gym} - {branch}. تاريخ عضويتك {expires}. يسعدنا مساعدتك.';
export function whatsAppText(s:GymState,m:Member,template:Pick<ManualWhatsAppTemplate,'body'|'name'>&{kind?:ManualWhatsAppTemplate['kind']},now:string,ar:boolean=true){
 const balance=(s.invoices??[]).filter(i=>i.member===m.id&&i.branch===m.branch).reduce((n,i)=>n+invoiceOutstanding(s,i),0);
 const fields:Record<string,string>={name:m.name,gym:s.settings.name,branch:s.branches.find(b=>b.id===m.branch)?.name??'',expires:m.expires,balance:(balance/100).toFixed(2)+' '+s.settings.currency,date:dayAt(now,s.settings.timezone),occasion:template.name};
 let rawBody=template.body;
 if(template.kind&&rawBody.trim()===LEGACY_DUMMY_BODY){
   rawBody=defaultWhatsApp(template.kind,ar);
 }
 return rawBody.replace(/\{(name|gym|branch|expires|balance|date|occasion)\}/g,(_,key)=>fields[key]);
}
export function memberWhatsAppLink(s:GymState,m:Member,branch:string,kind:ManualWhatsAppTemplate['kind'],ar:boolean,now:string,templateId?:string){
 if(m.branch!==branch||m.archived||m.demo||!s.members.some(x=>x.id===m.id&&x.branch===branch))return null;const phone=normalizeMemberPhone(m.phone);if(!phone)return null;
 const configured=s.manualWhatsApp?.find(t=>t.branch===branch&&t.enabled&&(templateId?t.id===templateId:t.kind===kind));if(templateId&&!configured)return null;
 const template=configured??{body:defaultWhatsApp(kind,ar),name:ar?'مناسبة سعيدة':'Best wishes',kind};
 return'https://wa.me/'+phone.slice(1)+'?text='+encodeURIComponent(whatsAppText(s,m,{...template,kind:template.kind??kind},now,ar));
}
export function manualWhatsAppDue(s:GymState,branch:string,now:string,serverLastVisits?:ReadonlyMap<string,string>|null){const today=dayAt(now,s.settings.timezone),lastVisits=new Map<string,string>(serverLastVisits??[]);if(!serverLastVisits)for(const v of s.visits)if(v.branch===branch&&v.day<=today&&v.day>(lastVisits.get(v.member)??''))lastVisits.set(v.member,v.day);return(s.manualWhatsApp??[]).filter(t=>t.branch===branch&&t.enabled).flatMap(t=>s.members.filter(m=>m.branch===branch&&!m.demo&&!m.archived).flatMap(m=>{
 const last=lastVisits.get(m.id)??m.joined,until=days(today,m.expires);if(['absence','renewal','expired'].includes(t.kind)&&(m.awaitingSubscription||m.freezes?.some(f=>!f.cancelled&&f.from<=today&&f.to>=today)))return[];
 const due=t.kind==='occasion'?t.date===today:t.kind==='birthday'?(m.health?.birthDate??m.birthDate)?.slice(5)===today.slice(5):t.kind==='welcome'||t.kind==='policy'?m.joined<=today&&days(m.joined,today)<=t.offset:t.kind==='absence'?m.expires>=today&&days(last,today)>=t.offset:t.kind==='renewal'?until>=0&&until<=t.offset:until<0&&until>=-t.offset;
 return due?[{member:m.id,template:t.id,kind:t.kind,name:t.name}]:[];
 }));}
