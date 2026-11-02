'use client';
import {useState,useRef} from 'react';
import type {GymState,Operation} from './lib/domain';
import {defaultWhatsApp,manualWhatsAppDue,memberWhatsAppLink,whatsAppText,type ManualWhatsAppTemplate} from './lib/manual-whatsapp';

const labels={
  welcome:['ترحيب بعضو جديد','Welcome new member'],
  renewal:['قرب انتهاء الاشتراك','Membership renewal soon'],
  expired:['انتهاء الاشتراك','Expired membership'],
  absence:['غياب وانقطاع عن التمرين','Attendance gap / Absence'],
  birthday:['عيد ميلاد العضو','Member birthday'],
  policy:['سياسات النادي والسلامة','Club policies & safety'],
  occasion:['مناسبة أو عيد خاص','Special occasion']
} as const;

type Props={state:GymState;branch:string;ar:boolean;mutate:(op:Omit<Operation,'branch'>&{type:string})=>Promise<boolean>};

function TemplateEditor({
  edit,
  templateKind,
  ar,
  busy,
  gymName,
  branchName,
  currency,
  onSave,
  onCancel,
  onChangeKind
}:{
  edit:ManualWhatsAppTemplate|null;
  templateKind:ManualWhatsAppTemplate['kind'];
  ar:boolean;
  busy:boolean;
  gymName:string;
  branchName:string;
  currency:string;
  onSave:(f:FormData)=>void;
  onCancel:()=>void;
  onChangeKind:(k:ManualWhatsAppTemplate['kind'])=>void;
}){
  const t=(a:string,b:string)=>ar?a:b;
  const [text,setText]=useState(edit?.body??defaultWhatsApp(templateKind,ar));
  const textareaRef=useRef<HTMLTextAreaElement>(null);

  const variables=[
    {key:'{name}',label:ar?'اسم العضو':'Member name'},
    {key:'{gym}',label:ar?'اسم النادي':'Gym name'},
    {key:'{branch}',label:ar?'الفرع':'Branch'},
    {key:'{expires}',label:ar?'تاريخ الانتهاء':'Expiry date'},
    {key:'{balance}',label:ar?'المديونية':'Balance'},
    {key:'{date}',label:ar?'تاريخ اليوم':'Date'},
    {key:'{occasion}',label:ar?'المناسبة':'Occasion'}
  ];

  function insertVariable(varKey:string){
    const el=textareaRef.current;
    if(!el){
      setText(prev=>prev+' '+varKey);
      return;
    }
    const start=el.selectionStart;
    const end=el.selectionEnd;
    const next=text.slice(0,start)+varKey+text.slice(end);
    setText(next);
    setTimeout(()=>{
      el.focus();
      el.setSelectionRange(start+varKey.length,start+varKey.length);
    },0);
  }

  function renderPreview(raw:string){
    const sample={
      name:ar?'أحمد محمد':'Ahmed Mohamed',
      gym:gymName||'GymEG',
      branch:branchName||(ar?'الفرع الرئيسي':'Main Branch'),
      expires:'2026-11-30',
      balance:'0.00 '+currency,
      date:new Date().toISOString().slice(0,10),
      occasion:edit?.name||(ar?'عيد الفطر المبارك':'Eid Mubarak')
    };
    return raw.replace(/\{(name|gym|branch|expires|balance|date|occasion)\}/g,(_,k)=>(sample as Record<string,string>)[k]??'');
  }

  return <form onSubmit={e=>{e.preventDefault();onSave(new FormData(e.currentTarget));}}>
    <label>{t('نوع القالب والحالة','Template kind & scenario')}
      <select value={templateKind} onChange={e=>{
        const nextKind=e.target.value as ManualWhatsAppTemplate['kind'];
        onChangeKind(nextKind);
        setText(defaultWhatsApp(nextKind,ar));
      }}>
        {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label[ar?0:1]}</option>)}
      </select>
    </label>

    <label>{t('اسم القالب أو المناسبة','Template or occasion name')}
      <input name="name" defaultValue={edit?.name??labels[templateKind][ar?0:1]} required maxLength={100}/>
    </label>

    <div>
      <label>{t('المتغيرات المتاحة للإدراج بضغطة واحدة:','Click to insert variable:')}</label>
      <div style={{display:'flex',flexWrap:'wrap',gap:'6px',marginBlock:'6px 12px'}}>
        {variables.map(v=><button
          type="button"
          key={v.key}
          onClick={()=>insertVariable(v.key)}
          className="button secondary"
          style={{padding:'4px 9px',fontSize:'0.8rem',borderRadius:6,margin:0}}
        >
          <b>{v.key}</b> ({v.label})
        </button>)}
      </div>
    </div>

    <label>{t('نص الرسالة','Message text')}
      <textarea
        ref={textareaRef}
        name="body"
        value={text}
        onChange={e=>setText(e.target.value)}
        maxLength={1500}
        required
        style={{minHeight:'110px'}}
      />
    </label>

    <div style={{display:'flex',gap:'8px',marginBottom:'12px'}}>
      <button
        type="button"
        className="button secondary"
        onClick={()=>setText(defaultWhatsApp(templateKind,ar))}
        style={{fontSize:'0.82rem',padding:'6px 12px'}}
      >
        {t('استعادة النص النموذجي الموصى به لهذا النوع','Reset to recommended template')}
      </button>
    </div>

    <div style={{background:'var(--surface-soft,#f8fafc)',border:'1px solid var(--line)',borderRadius:10,padding:'12px 16px',marginBlock:'12px'}}>
      <small style={{fontWeight:700,display:'block',marginBottom:6,color:'var(--purple,#7c3aed)'}}>
        {t('📱 معاينة حية لشكل الرسالة في واتساب:','📱 Live WhatsApp Preview:')}
      </small>
      <div style={{
        background:'#dcf8c6',
        color:'#111827',
        padding:'10px 14px',
        borderRadius:ar?'12px 12px 0 12px':'12px 12px 12px 0',
        maxWidth:'520px',
        fontSize:'0.92rem',
        whiteSpace:'pre-wrap',
        border:'1px solid #bbf7d0',
        boxShadow:'0 1px 2px rgba(0,0,0,0.05)',
        lineHeight:'1.6'
      }}>
        {renderPreview(text)}
      </div>
    </div>

    <label>{t('فترة التطبيق (أيام قبل الانتهاء أو بعد الغياب)','Follow-up offset (days)')}
      <input name="offset" type="number" min={1} max={90} defaultValue={edit?.offset??7} required/>
    </label>

    {templateKind==='occasion'&&(
      <label>{t('تاريخ المناسبة','Occasion date')}
        <input name="date" type="date" defaultValue={edit?.date} required/>
      </label>
    )}

    <label className="checkbox">
      <input name="enabled" type="checkbox" defaultChecked={edit?.enabled??true}/>
      {t('تفعيل هذا القالب وإظهار متابعاته التلقائية','Enable template for due follow-ups')}
    </label>

    <div style={{display:'flex',gap:'8px',marginTop:'12px'}}>
      <button className="button primary" disabled={busy}>
        {t('حفظ القالب','Save template')}
      </button>
      {edit&&(
        <button type="button" className="button secondary" onClick={onCancel}>
          {t('إلغاء التعديل / قالب جديد','Cancel / New template')}
        </button>
      )}
    </div>
  </form>;
}

export default function ManualWhatsApp({state,branch,ar,mutate}:Props){
 const [search,setSearch]=useState(''),[kind,setKind]=useState<ManualWhatsAppTemplate['kind']>('renewal'),[templateKind,setTemplateKind]=useState<ManualWhatsAppTemplate['kind']>('renewal'),[templateId,setTemplateId]=useState(''),[edit,setEdit]=useState<ManualWhatsAppTemplate|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const t=(a:string,b:string)=>ar?a:b,now=new Date().toISOString(),members=state.members.filter(m=>m.branch===branch&&!m.archived&&!m.demo),byId=new Map(members.map(m=>[m.id,m])),templates=(state.manualWhatsApp??[]).filter(x=>x.branch===branch),due=manualWhatsAppDue(state,branch,now),matches=(s:string)=>s.toLocaleLowerCase().includes(search.toLocaleLowerCase());
 const branchName=state.branches.find(b=>b.id===branch)?.name??'';

 async function save(f:FormData){
  if(busy)return;setBusy(true);
  try{
    if(await mutate({type:'whatsapp.manual.save',...(edit?{id:edit.id}:{}),name:f.get('name'),kind:templateKind,body:f.get('body'),enabled:f.get('enabled')==='on',offset:Number(f.get('offset')),date:f.get('date')||undefined})){
      setEdit(null);
      setNotice(t('تم حفظ القالب بنجاح.','Template saved successfully.'));
    }
  }finally{setBusy(false);}
 }

 return <section className="connect-workspace">
  <h1>{t('واتساب الأعضاء والمناسبات','Member & occasion WhatsApp')}</h1>
  <p>{t('يفتح الزر محادثة العضو والنص المجهّز؛ راجع الرسالة وأرسلها بنفسك. لا يُسجل فتح واتساب كإرسال أو تسليم.','Open the member chat with prepared text; review and send it yourself. Opening WhatsApp is not recorded as sent or delivered.')}</p>

  <label>{t('بحث بالاسم أو الهاتف','Search name or phone')}<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder={t('ابحث عن اسم عضو أو هاتفه...','Search member name or phone...')}/></label>
  {notice&&<p role="status" className="operation-notice">{notice}</p>}

  <section className="card">
    <h2>{t('متابعات ومناسبات مستحقة','Due follow-ups & occasions')} ({due.length})</h2>
    <div style={{display:'grid',gap:'8px',marginTop:'12px'}}>
      {due.filter(x=>{const m=byId.get(x.member);return m&&matches(m.name+' '+m.phone);}).slice(0,50).map(x=>{
        const m=byId.get(x.member)!;
        const href=memberWhatsAppLink(state,m,branch,x.kind,ar,now,x.template);
        const templateObj=templates.find(t=>t.id===x.template);
        return <article className="preference-row" key={x.member+'|'+x.template}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'4px',flexWrap:'wrap'}}>
              <b>{m.name}</b>
              <span style={{fontSize:'0.75rem',padding:'2px 7px',borderRadius:6,background:'var(--purple-soft,#ede9fe)',color:'var(--purple,#7c3aed)',fontWeight:700}}>
                {labels[x.kind][ar?0:1]}
              </span>
              <small><bdi>{m.phone}</bdi></small>
            </div>
            <p style={{margin:0,fontSize:'0.88rem',opacity:.85}}>{x.name}</p>
            {templateObj&&<details style={{marginTop:'6px'}}>
              <summary style={{fontSize:'0.8rem',cursor:'pointer',color:'var(--purple,#7c3aed)'}}>{t('معاينة نص الرسالة','Preview text')}</summary>
              <p style={{fontSize:'0.85rem',whiteSpace:'pre-wrap',margin:'6px 0',background:'var(--surface-soft,#f8fafc)',padding:'8px 12px',borderRadius:8}}>
                {whatsAppText(state,m,templateObj,now)}
              </p>
            </details>}
          </div>
          <div>
            {href?<a className="button primary" href={href} target="_blank" rel="noopener noreferrer">{t('فتح واتساب','Open WhatsApp')}</a>:<span style={{color:'var(--muted)'}}>{t('راجع رقم الهاتف','Check phone number')}</span>}
          </div>
        </article>;
      })}
      {!due.length&&<p>{t('لا توجد مناسبات أو متابعات مستحقة اليوم من القوالب المفعلة.','No due occasions or follow-ups today.')}</p>}
    </div>
  </section>

  <section className="card">
    <h2>{t('محادثة عضو مباشر','Direct member message')}</h2>
    <label>{t('نوع الرسالة','Message kind')}
      <select value={kind} onChange={e=>{setKind(e.target.value as typeof kind);setTemplateId('');}}>
        {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label[ar?0:1]}</option>)}
      </select>
    </label>
    <label>{t('القالب المستخدم','Template used')}
      <select value={templateId} onChange={e=>setTemplateId(e.target.value)}>
        <option value="">{t('القالب النموذجي الافتراضي','Default recommended template')}</option>
        {templates.filter(x=>x.enabled&&x.kind===kind).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </label>
    <div style={{display:'grid',gap:'8px',marginTop:'12px'}}>
      {members.filter(m=>matches(m.name+' '+m.phone)).slice(0,50).map(m=>{
        const href=memberWhatsAppLink(state,m,branch,kind,ar,now,templateId||undefined);
        return <article className="preference-row" key={m.id}>
          <div>
            <b>{m.name}</b>
            <small style={{display:'block',opacity:.7}}><bdi>{m.phone}</bdi></small>
          </div>
          {href?<a className="button secondary" href={href} target="_blank" rel="noopener noreferrer">{t('تجهيز الرسالة وفتح واتساب','Open WhatsApp')}</a>:<span style={{color:'var(--muted)'}}>{t('رقم غير صالح','Invalid number')}</span>}
        </article>;
      })}
    </div>
    <p style={{fontSize:'0.82rem',color:'var(--muted)',marginTop:'10px'}}>{t('استخدم البحث بالأعلى للوصول السريع للعضو؛ تعرض القائمة حتى ٥٠ نتيجة.','Use search above to find members; up to 50 are shown.')}</p>
  </section>

  <details className="card" open={Boolean(edit)}>
    <summary>{edit?t('تعديل قالب واتساب','Edit WhatsApp template'):t('إعداد وتخصيص قوالب الرسائل والمناسبات','Configure & customize templates')}</summary>
    <TemplateEditor
      key={(edit?.id??'new')+'|'+templateKind+'|'+ar}
      edit={edit}
      templateKind={templateKind}
      ar={ar}
      busy={busy}
      gymName={state.settings.name}
      branchName={branchName}
      currency={state.settings.currency}
      onSave={save}
      onCancel={()=>{setEdit(null);}}
      onChangeKind={k=>setTemplateKind(k)}
    />
    <h3 style={{marginBlock:'20px 10px'}}>{t('القوالب المحفوظة للفرع','Saved branch templates')} ({templates.length})</h3>
    <div style={{display:'grid',gap:'8px'}}>
      {templates.map(x=><article className="preference-row" key={x.id}>
        <div>
          <b>{x.name}</b>
          <span style={{fontSize:'0.75rem',marginInlineStart:'8px',padding:'2px 7px',borderRadius:6,background:'var(--surface-soft,#f1f5f9)'}}>
            {labels[x.kind][ar?0:1]}
          </span>
          <span style={{fontSize:'0.75rem',marginInlineStart:'6px',color:x.enabled?'var(--green,#16a34a)':'var(--muted)'}}>
            {x.enabled?t('● فعال','● Enabled'):t('○ متوقف','○ Disabled')}
          </span>
        </div>
        <button className="button secondary" onClick={()=>{setEdit(x);setTemplateKind(x.kind);}}>
          {t('تعديل القالب','Edit')}
        </button>
      </article>)}
      {!templates.length&&<p style={{color:'var(--muted)'}}>{t('لا توجد قوالب مخصصة محفوظة بعد؛ يتم استخدام القوالب النموذجية الافتراضية.','No custom templates yet; default recommended templates are used.')}</p>}
    </div>
  </details>
 </section>;
}
