import {z} from 'zod';
import {RuleError,dayAt,days,type GymState,type Member,type Operation} from './domain.ts';
import {normalizeMemberPhone} from './member-phone-format.ts';
import {invoiceOutstanding} from './member-ledger.ts';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v);
export const manualTemplateSchema=z.object({id:z.string().min(1).max(250),branch:z.string().min(1).max(250),name:z.string().trim().min(1).max(100),kind:z.enum(['welcome','policy','birthday','occasion','absence','renewal','expired']),body:z.string().trim().min(1).max(1500).refine(v=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)),enabled:z.boolean(),offset:z.number().int().min(1).max(90),date:date.optional()}).strict().refine(x=>x.kind!=='occasion'||Boolean(x.date));
export const manualWhatsAppSchema=z.array(manualTemplateSchema).max(100);
export type ManualWhatsAppTemplate=z.infer<typeof manualTemplateSchema>;
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
 const due=t.kind==='occasion'?t.date===today:t.kind==='birthday'?m.health?.birthDate?.slice(5)===today.slice(5):t.kind==='welcome'||t.kind==='policy'?m.joined<=today&&days(m.joined,today)<=t.offset:t.kind==='absence'?m.expires>=today&&days(last,today)>=t.offset:t.kind==='renewal'?until>=0&&until<=t.offset:until<0&&until>=-t.offset;
 return due?[{member:m.id,template:t.id,kind:t.kind,name:t.name}]:[];
 }));}
