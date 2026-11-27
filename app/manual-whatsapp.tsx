'use client';
import {useState,useRef,useMemo,useEffect} from 'react';
import type {GymState,Operation,Member} from './lib/domain';
import {dayAt} from './lib/domain';
import {useLastVisits,LAZY_STRICT,LAST_VISITS_ON} from './use-last-visits';
import {defaultWhatsApp,manualWhatsAppDue,whatsAppText,LEGACY_DUMMY_BODY,WHATSAPP_TEMPLATE_PRESETS,type ManualWhatsAppTemplate,type WhatsAppPresetCategory} from './lib/manual-whatsapp';

const labels={
  welcome:['ترحيب بعضو جديد','Welcome new member'],
  renewal:['قرب انتهاء الاشتراك','Membership renewal soon'],
  expired:['انتهاء الاشتراك','Expired membership'],
  absence:['غياب وانقطاع عن التمرين','Attendance gap / Absence'],
  birthday:['عيد ميلاد العضو','Member birthday'],
  policy:['سياسات النادي والسلامة','Club policies & safety'],
  occasion:['مناسبة أو عيد خاص','Special occasion']
} as const;

type Props={state:GymState;owner?:string;branch:string;ar:boolean;mutate:(op:Omit<Operation,'branch'>&{type:string})=>Promise<boolean>};

interface SendModalState {
  member: Member;
  kind: ManualWhatsAppTemplate['kind'];
  templateId?: string;
  customText: string;
}

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
  const initialText=(edit?.body&&edit.body.trim()!==LEGACY_DUMMY_BODY)
    ?edit.body
    :defaultWhatsApp(templateKind,ar);
  const [text,setText]=useState(initialText);
  const [nameVal,setNameVal]=useState(edit?.name??labels[templateKind][ar?0:1]);
  const [offsetVal,setOffsetVal]=useState(edit?.offset??7);
  const [presetCat,setPresetCat]=useState<'all'|WhatsAppPresetCategory>('all');
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
    {!edit&&(
      <div style={{background:'var(--surface-soft,#f8fafc)',border:'1px solid var(--line)',borderRadius:10,padding:'12px 14px',marginBottom:'14px'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'8px',marginBottom:'8px'}}>
          <b style={{fontSize:'0.92rem'}}>{t('📚 مكتبة القوالب الجاهزة (اضغط لاختيار قالب وتعديله)','📚 Ready-made Template Library (Click to load)')}</b>
          <div style={{display:'flex',gap:'6px',flexWrap:'wrap'}}>
            {([
              ['all',t('الكل','All')],
              ['statuses',t('حالات الأعضاء','Statuses')],
              ['religious',t('مناسبات دينية','Religious')],
              ['holidays',t('أعياد ومناسبات','Holidays')],
              ['offers',t('عروض وتخفيضات','Offers')]
            ] as const).map(([cat,lbl])=>(
              <button
                key={cat}
                type="button"
                className={`button ${presetCat===cat?'primary':'secondary'}`}
                style={{padding:'3px 9px',fontSize:'0.78rem',margin:0}}
                onClick={()=>setPresetCat(cat)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <div style={{display:'flex',flexWrap:'wrap',gap:'6px',maxHeight:'150px',overflowY:'auto'}}>
          {WHATSAPP_TEMPLATE_PRESETS.filter(p=>presetCat==='all'||p.category===presetCat).map(p=>(
            <button
              key={p.id}
              type="button"
              className="button secondary"
              style={{padding:'5px 10px',fontSize:'0.8rem',margin:0,textAlign:'start'}}
              onClick={()=>{
                onChangeKind(p.kind);
                setNameVal(ar?p.titleAr:p.titleEn);
                setText(ar?p.bodyAr:p.bodyEn);
                setOffsetVal(p.offset);
              }}
            >
              {ar?p.titleAr:p.titleEn}
            </button>
          ))}
        </div>
      </div>
    )}

    <label>{t('نوع القالب والحالة','Template kind & scenario')}
      <select value={templateKind} onChange={e=>{
        const nextKind=e.target.value as ManualWhatsAppTemplate['kind'];
        onChangeKind(nextKind);
        setNameVal(labels[nextKind][ar?0:1]);
        setText(defaultWhatsApp(nextKind,ar));
      }}>
        {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label[ar?0:1]}</option>)}
      </select>
    </label>

    <label>{t('اسم القالب أو المناسبة','Template or occasion name')}
      <input name="name" value={nameVal} onChange={e=>setNameVal(e.target.value)} required maxLength={100}/>
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
      <input name="offset" type="number" min={1} max={90} value={offsetVal} onChange={e=>setOffsetVal(Number(e.target.value)||1)} required/>
    </label>

    {templateKind==='occasion'&&(
      <label>{t('تاريخ المناسبة','Occasion date')}
        <input name="date" type="date" defaultValue={edit?.date??dayAt(new Date().toISOString(),'Africa/Cairo')} required/>
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

export default function ManualWhatsApp({state,owner,branch,ar,mutate}:Props){
  const [search,setSearch]=useState('');
  const [kind,setKind]=useState<ManualWhatsAppTemplate['kind']>('renewal');
  const [activeTab,setActiveTab]=useState<'due'|'direct'|'templates'>('due');
  const [filterKind,setFilterKind]=useState<string>('all');
  const [templateKind,setTemplateKind]=useState<ManualWhatsAppTemplate['kind']>('renewal');
  const [templateId,setTemplateId]=useState('');
  const [edit,setEdit]=useState<ManualWhatsAppTemplate|null>(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [modalState,setModalState]=useState<SendModalState|null>(null);
  const [wppConnected,setWppConnected]=useState(false);
  const [sentKeys,setSentKeys]=useState<Record<string,boolean>>({});

  useEffect(()=>{
    let cancelled=false;
    fetch(`/api/whatsapp?branch=${encodeURIComponent(branch)}`)
      .then(r=>r.ok?r.json():null)
      .then(d=>{if(!cancelled&&d?.wppConnection?.status==='CONNECTED')setWppConnected(true);else if(!cancelled)setWppConnected(false);})
      .catch(()=>{});
    return()=>{cancelled=true;};
  },[branch]);

  const t=(a:string,b:string)=>ar?a:b;
  const now=new Date().toISOString();
  const members=state.members.filter(m=>m.branch===branch&&!m.archived&&!m.demo);
  const byId=useMemo(()=>new Map(members.map(m=>[m.id,m])),[members]);
  const rawTemplates=useMemo(()=>(state.manualWhatsApp??[]).filter(x=>x.branch===branch),[state.manualWhatsApp,branch]);
  const templates=useMemo(()=>{
    return rawTemplates.map(t=>{
      const isLegacy=t.body.includes('تاريخ عضويتك {expires}. يسعدنا مساعدتك')||t.body.trim()===LEGACY_DUMMY_BODY;
      const isLegacyName=t.name.startsWith('قالب ')||t.name===t.kind;
      return {
        ...t,
        name:isLegacyName?labels[t.kind][ar?0:1]:t.name,
        body:isLegacy?defaultWhatsApp(t.kind,ar):t.body
      };
    });
  },[rawTemplates,ar]);
  const {last:serverLast,failed:lastFailed,retry:lastRetry}=useLastVisits(state,owner,branch,dayAt(now,state.settings.timezone)),lastStrict=LAZY_STRICT&&LAST_VISITS_ON&&!serverLast;
  const due=useMemo(()=>lastStrict?[]:manualWhatsAppDue(state,branch,now,serverLast),[state,branch,now,serverLast,lastStrict]);
  const branchName=state.branches.find(b=>b.id===branch)?.name??'';

  // Counts per scenario for badges
  const dueCounts=useMemo(()=>{
    const counts:Record<string,number>={all:due.length};
    for(const d of due){
      counts[d.kind]=(counts[d.kind]??0)+1;
    }
    return counts;
  },[due]);

  const filteredDue=useMemo(()=>{
    const term=search.trim().toLocaleLowerCase();
    return due.filter(x=>{
      if(filterKind!=='all'&&x.kind!==filterKind)return false;
      const m=byId.get(x.member);
      if(!m)return false;
      return !term||(m.name+' '+m.phone).toLocaleLowerCase().includes(term);
    });
  },[due,filterKind,byId,search]);

  async function save(f:FormData){
    if(busy)return;setBusy(true);
    try{
      if(await mutate({type:'whatsapp.manual.save',...(edit?{id:edit.id}:{}),name:f.get('name'),kind:templateKind,body:f.get('body'),enabled:f.get('enabled')==='on',offset:Number(f.get('offset')),date:f.get('date')||undefined})){
        setEdit(null);
        setNotice(t('تم حفظ القالب بنجاح.','Template saved successfully.'));
      }
    }finally{setBusy(false);}
  }

  async function importOccasionAndOfferPresets(){
    if(busy)return;setBusy(true);
    try{
      const todayStr=dayAt(now,state.settings.timezone);
      const existingNames=new Set(rawTemplates.map(x=>x.name.trim()));
      let added=0;
      for(const p of WHATSAPP_TEMPLATE_PRESETS.filter(x=>x.category!=='statuses')){
        const title=ar?p.titleAr:p.titleEn;
        if(existingNames.has(title))continue;
        if(rawTemplates.length+added>=95)break;
        const ok=await mutate({
          type:'whatsapp.manual.save',
          name:title,
          kind:p.kind,
          body:ar?p.bodyAr:p.bodyEn,
          enabled:true,
          offset:p.offset,
          ...(p.kind==='occasion'?{date:todayStr}:{})
        });
        if(ok)added++;
      }
      setNotice(t(`تمت إضافة ${added} قالب للمناسبات الدينية والأعياد والعروض إلى مكتبة الفرع! 🎉`,`Added ${added} holiday, religious & offer template(s) to this branch! 🎉`));
    }finally{setBusy(false);}
  }

  async function upgradeAllTemplatesToRecommended(){
    if(busy)return;setBusy(true);
    try{
      for(const k of ['welcome','policy','birthday','absence','renewal','expired'] as const){
        const existing=rawTemplates.find(t=>t.kind===k);
        await mutate({
          type:'whatsapp.manual.save',
          ...(existing?{id:existing.id}:{}),
          name:labels[k][ar?0:1],
          kind:k,
          body:defaultWhatsApp(k,ar),
          enabled:true,
          offset:existing?.offset??7
        });
      }
      setNotice(t('تم تحديث وتخصيص جميع قوالب الفرع إلى النصوص النموذجية المعتمدة لكل حالة بنجاح! 💪','All branch templates upgraded to dedicated scenario texts successfully! 💪'));
    }finally{setBusy(false);}
  }



  function openComposer(m:Member,msgKind:ManualWhatsAppTemplate['kind'],tmplId?:string){
    let tmpl: Pick<ManualWhatsAppTemplate,'body'|'name'|'kind'>;
    if(tmplId){
      const found=templates.find(t=>t.id===tmplId);
      if(found&&found.body.trim()!==LEGACY_DUMMY_BODY){
        tmpl=found;
      }else{
        tmpl={body:defaultWhatsApp(msgKind,ar),name:found?.name??labels[msgKind][ar?0:1],kind:msgKind};
      }
    }else{
      // Specifically selected default recommended template for this case
      tmpl={body:defaultWhatsApp(msgKind,ar),name:labels[msgKind][ar?0:1],kind:msgKind};
    }
    const text=whatsAppText(state,m,tmpl,now,ar);
    setModalState({member:m,kind:msgKind,templateId:tmplId,customText:text});
  }

  async function sendViaWpp(m:Member,msgKind:ManualWhatsAppTemplate['kind'],text:string,tmplId?:string){
    if(busy)return;setBusy(true);
    try{
      const r=await fetch(`/api/whatsapp?branch=${encodeURIComponent(branch)}`,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'wpp.sendReminder',memberId:m.id,phone:m.phone,text,templateId:tmplId??msgKind,kind:msgKind})
      });
      if(r.ok){
        setSentKeys(prev=>({...prev,[`${m.id}|${tmplId??msgKind}`]:true}));
        setNotice(t(`تمت جدولة إشعار ${m.name} للإرسال التلقائي عبر واتساب بنجاح.`, `Queued automatic WhatsApp reminder for ${m.name}.`));
        setModalState(null);
      }else if(r.status===409){
        setSentKeys(prev=>({...prev,[`${m.id}|${tmplId??msgKind}`]:true}));
        setNotice(t(`تم إرسال هذا التذكير لـ ${m.name} بالفعل اليوم ✓`, `This reminder was already sent to ${m.name} today ✓`));
        setModalState(null);
      }else{
        setNotice(t('تعذر الإرسال الآلي؛ تأكد من أن رقم العضو يبدأ برمز الدولة (مثل +20).','Auto-send failed; ensure the phone includes country code (e.g. +20).'));
      }
    }finally{setBusy(false);}
  }

  async function runAllDueViaWpp(){
    if(busy)return;setBusy(true);
    try{
      const r=await fetch(`/api/whatsapp?branch=${encodeURIComponent(branch)}`,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'wpp.runReminders'})
      });
      const d=await r.json().catch(()=>({}));
      if(r.ok){
        setNotice(t(`تمت مزامنة وجدولة ${d.enqueued??0} تذكير مستحق للإرسال الآلي عبر WPPConnect.`, `Synced & queued ${d.enqueued??0} due reminder(s) for automatic WPPConnect delivery.`));
      }else{
        setNotice(t('تعذر تشغيل الإرسال الآلي للتذكيرات.','Failed to run automatic reminders.'));
      }
    }finally{setBusy(false);}
  }

  function launchWhatsApp(phone:string,text:string,mode:'app'|'web'){
    const cleanPhone=phone.replace(/[^0-9]/g,'');
    const encoded=encodeURIComponent(text);
    if(mode==='app'){
      // Protocol handler opens installed WhatsApp app on Windows, macOS, Android, and iOS
      window.location.href=`whatsapp://send?phone=${cleanPhone}&text=${encoded}`;
      // Fallback popup if app is not registered
      setTimeout(()=>{
        window.open(`https://wa.me/${cleanPhone}?text=${encoded}`,'_blank','noopener,noreferrer');
      },600);
    }else{
      window.open(`https://web.whatsapp.com/send?phone=${cleanPhone}&text=${encoded}`,'_blank','noopener,noreferrer');
    }
    setModalState(null);
  }

  return <section className="connect-workspace">
    {/* Header banner */}
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:'12px',marginBottom:'16px'}}>
      <div>
        <h1 style={{margin:0}}>{t('💬 واتساب الأعضاء والمناسبات والتذكير الذكي','💬 Member & Occasion WhatsApp Studio')}</h1>
        <p style={{margin:'4px 0 0',opacity:.8,fontSize:'0.9rem'}}>
          {t('إرسال فوري ومباشر لرسائل الترحيب، التجديد، الغياب، والأعياد مع إمكانية الفتح في برنامج واتساب المكتبي أو واتساب ويب بنقرة واحدة.','Instant WhatsApp dispatch for welcome, renewals, absences & birthdays with 1-click launch in desktop app or web.')}
        </p>
      </div>
      <div style={{display:'flex',gap:'8px'}}>
        <span style={{background:'var(--surface-soft,#f1f5f9)',padding:'6px 12px',borderRadius:8,fontSize:'0.85rem',fontWeight:600}}>
          {t('الفرع: ','Branch: ')}<b>{branchName||branch}</b>
        </span>
      </div>
    </div>

    {notice&&<p role="status" className="operation-notice">{notice}</p>}

    {/* Quick stats & status banner */}
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:'12px',marginBottom:'20px'}}>
      <div className="card" style={{padding:'14px 18px',margin:0,background:'linear-gradient(135deg,rgba(124,58,237,0.08),rgba(124,58,237,0.02))',border:'1px solid rgba(124,58,237,0.2)'}}>
        <small style={{display:'block',opacity:.7,fontWeight:600}}>{t('متابعات مستحقة اليوم','Due Follow-ups Today')}</small>
        <strong style={{fontSize:'1.8rem',color:'var(--purple,#7c3aed)'}}>{due.length}</strong>
      </div>
      <div className="card" style={{padding:'14px 18px',margin:0}}>
        <small style={{display:'block',opacity:.7,fontWeight:600}}>{t('أعضاء الفرع النشطين','Active Members')}</small>
        <strong style={{fontSize:'1.8rem'}}>{members.length}</strong>
      </div>
      <div className="card" style={{padding:'14px 18px',margin:0}}>
        <small style={{display:'block',opacity:.7,fontWeight:600}}>{t('القوالب المفعلة','Active Templates')}</small>
        <strong style={{fontSize:'1.8rem'}}>{templates.filter(x=>x.enabled).length} / {templates.length||7}</strong>
      </div>
    </div>

    {/* Navigation Tabs */}
    <div style={{display:'flex',gap:'8px',borderBottom:'2px solid var(--line)',paddingBottom:'8px',marginBottom:'16px',flexWrap:'wrap'}}>
      <button
        type="button"
        className={`button ${activeTab==='due'?'primary':'secondary'}`}
        onClick={()=>setActiveTab('due')}
        style={{display:'flex',alignItems:'center',gap:'8px'}}
      >
        <span>{t('⚡ التذكيرات والمناسبات المستحقة','⚡ Due Follow-ups & Reminders')}</span>
        <span style={{background:activeTab==='due'?'rgba(255,255,255,0.3)':'var(--purple-soft,#ede9fe)',color:activeTab==='due'?'#fff':'var(--purple,#7c3aed)',padding:'2px 7px',borderRadius:10,fontSize:'0.75rem',fontWeight:700}}>
          {due.length}
        </span>
      </button>

      <button
        type="button"
        className={`button ${activeTab==='direct'?'primary':'secondary'}`}
        onClick={()=>setActiveTab('direct')}
      >
        {t('👤 محادثة عضو مباشر وبحث مخصص','👤 Direct Member Chat')}
      </button>

      <button
        type="button"
        className={`button ${activeTab==='templates'?'primary':'secondary'}`}
        onClick={()=>setActiveTab('templates')}
      >
        {t('⚙️ إعداد وتخصيص القوالب','⚙️ Template Studio')}
      </button>
    </div>

    {/* Search Box */}
    {activeTab!=='templates'&&(
      <div style={{marginBottom:'16px'}}>
        <input
          type="search"
          value={search}
          onChange={e=>setSearch(e.target.value)}
          placeholder={t('🔍 ابحث بالاسم، رقم الهاتف أو الكارت للوصول السريع...','🔍 Search member by name or phone...')}
          style={{fontSize:'1rem',padding:'10px 14px',borderRadius:10,width:'100%'}}
        />
      </div>
    )}

    {/* TAB 1: Due follow-ups */}
    {activeTab==='due'&&(
      <section className="card">
        {(lastFailed||lastStrict)&&<p className="operation-notice" role="status">{lastFailed?<>{t('تعذر تحميل آخر زيارة للأعضاء.','Could not load members\' last visits.')} <button className="button secondary" onClick={lastRetry}>{t('إعادة المحاولة','Retry')}</button></>:t('جارٍ التحميل…','Loading…')}</p>}
        {(['welcome','renewal','expired','absence','birthday'] as const).some(k=>!templates.some(x=>x.kind===k&&x.enabled))&&(
          <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:'10px',padding:'10px 14px',borderRadius:10,background:'rgba(245,158,11,0.1)',border:'1px solid rgba(245,158,11,0.35)',marginBottom:'14px'}}>
            <small style={{fontWeight:600,lineHeight:'1.5'}}>
              {t('💡 بعض حالات الأعضاء (قرب الانتهاء، المنتهي، الغياب، عيد الميلاد) لا تظهر لأن قوالبها غير مفعلة لهذا الفرع بعد.','💡 Some member statuses (renewal, expired, absence, birthday) are hidden because their templates are not enabled for this branch yet.')}
            </small>
            <button type="button" className="button primary" disabled={busy} onClick={()=>void upgradeAllTemplatesToRecommended()} style={{padding:'6px 12px',fontSize:'0.82rem',margin:0}}>
              {t('✨ تفعيل قوالب جميع الحالات الآن','✨ Enable All Status Templates')}
            </button>
          </div>
        )}
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'10px',marginBottom:'14px'}}>
          <div>
            <h2 style={{margin:0}}>{t('قائمة المتابعات والتذكيرات المستحقة اليوم','Due Follow-ups & Reminders')}</h2>
            {wppConnected&&(
              <small style={{display:'inline-block',marginTop:4,color:'#16a34a',fontWeight:700}}>
                {t('🤖 الإرسال التلقائي عبر WPPConnect مفعّل ومتصل — يتم إرسال التذكيرات المستحقة تلقائياً كل 5 دقائق','🤖 Automatic WPPConnect sending active — due reminders auto-dispatch every 5 minutes')}
              </small>
            )}
          </div>
          <div style={{display:'flex',gap:'8px',flexWrap:'wrap',alignItems:'center'}}>
            {wppConnected&&due.length>0&&(
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={()=>void runAllDueViaWpp()}
                style={{padding:'6px 12px',fontSize:'0.82rem',margin:0}}
              >
                {t('⚡ إرسال كل المستحقات آلياً','⚡ Auto-Send All Due')}
              </button>
            )}
          {/* Filter Pills */}
          <div style={{display:'flex',gap:'6px',flexWrap:'wrap'}}>
            <button
              type="button"
              className={`button ${filterKind==='all'?'primary':'secondary'}`}
              style={{padding:'4px 10px',fontSize:'0.8rem',margin:0}}
              onClick={()=>setFilterKind('all')}
            >
              {t('الكل','All')} ({dueCounts.all??0})
            </button>
            {Object.entries(labels).map(([k,l])=>{
              const count=dueCounts[k]??0;
              if(!count)return null;
              return <button
                type="button"
                key={k}
                className={`button ${filterKind==='all'?'secondary':filterKind===k?'primary':'secondary'}`}
                style={{padding:'4px 10px',fontSize:'0.8rem',margin:0}}
                onClick={()=>setFilterKind(k)}
              >
                {l[ar?0:1]} ({count})
              </button>;
            })}
          </div>
          </div>
        </div>

        <div style={{display:'grid',gap:'10px'}}>
          {filteredDue.slice(0,60).map(x=>{
            const m=byId.get(x.member)!;
            const templateObj=templates.find(t=>t.id===x.template);
            const tmpl: Pick<ManualWhatsAppTemplate,'body'|'name'|'kind'>=(templateObj&&templateObj.body.trim()!==LEGACY_DUMMY_BODY)
              ?templateObj
              :{body:defaultWhatsApp(x.kind,ar),name:templateObj?.name??labels[x.kind][ar?0:1],kind:x.kind};
            return <article className="preference-row" key={x.member+'|'+x.template} style={{padding:'12px 16px',borderRadius:10,border:'1px solid var(--line)',background:'var(--surface)',display:'flex',flexWrap:'wrap',gap:'12px',alignItems:'center',justifyContent:'space-between'}}>
              <div style={{flex:'1 1 220px',minWidth:0}}>
                <div style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'4px',flexWrap:'wrap'}}>
                  <strong style={{fontSize:'1rem'}}>{m.name}</strong>
                  <span style={{fontSize:'0.75rem',padding:'2px 8px',borderRadius:6,background:'var(--purple-soft,#ede9fe)',color:'var(--purple,#7c3aed)',fontWeight:700}}>
                    {labels[x.kind][ar?0:1]}
                  </span>
                  <small style={{direction:'ltr',opacity:.75,fontWeight:600}}><bdi>{m.phone}</bdi></small>
                </div>
                <div style={{fontSize:'0.84rem',opacity:.8,display:'flex',gap:'12px',flexWrap:'wrap'}}>
                  <span>{t('ينتهي: ','Expires: ')}<b>{m.expires}</b></span>
                  {m.health?.birthDate&&x.kind==='birthday'&&<span>{t('الميلاد: ','Birthday: ')}<b>{m.health.birthDate}</b></span>}
                </div>
                {templateObj&&<details style={{marginTop:'8px'}}>
                  <summary style={{fontSize:'0.82rem',cursor:'pointer',color:'var(--purple,#7c3aed)',fontWeight:600}}>
                    {t('👁️ معاينة نص الرسالة المجهزة','👁️ Preview message text')}
                  </summary>
                  <p style={{fontSize:'0.85rem',whiteSpace:'pre-wrap',margin:'8px 0',background:'var(--surface-soft,#f8fafc)',padding:'10px 14px',borderRadius:8,border:'1px solid var(--line)',lineHeight:'1.6'}}>
                    {whatsAppText(state,m,tmpl,now,ar)}
                  </p>
                </details>}
              </div>

              <div style={{display:'flex',gap:'8px',flexWrap:'wrap',alignItems:'center'}}>
                {wppConnected&&(
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy||sentKeys[`${m.id}|${x.template}`]}
                    onClick={()=>void sendViaWpp(m,x.kind,whatsAppText(state,m,tmpl,now,ar),x.template)}
                    style={{display:'flex',alignItems:'center',gap:'6px'}}
                  >
                    <span>⚡</span>
                    <span>{sentKeys[`${m.id}|${x.template}`]?t('تمت الجدولة ✓','Queued ✓'):t('إرسال آلي','Auto-Send')}</span>
                  </button>
                )}
                <button
                  type="button"
                  className={wppConnected?'button secondary':'button primary'}
                  onClick={()=>openComposer(m,x.kind,x.template)}
                  style={{display:'flex',alignItems:'center',gap:'6px'}}
                >
                  <span>📲</span>
                  <span>{t('إرسال وتجهيز','Compose & Send')}</span>
                </button>
              </div>
            </article>;
          })}

          {!filteredDue.length&&(
            <div style={{textAlign:'center',padding:'30px 15px',background:'var(--surface-soft,#f8fafc)',borderRadius:12}}>
              <p style={{fontSize:'1.05rem',margin:0,fontWeight:600}}>{t('🎉 لا توجد تذكيرات مستحقة حالياً لهذه الفئة!','🎉 No due follow-ups for this category!')}</p>
              <small style={{display:'block',opacity:.7,marginTop:'6px'}}>{t('يتم رصد حالات الغياب، قرب انتهاء الاشتراكات، وأعياد الميلاد تلقائياً بحسب فترات القوالب المحددة.','Renewals, attendance gaps and birthdays are tracked automatically based on template offsets.')}</small>
            </div>
          )}
        </div>
      </section>
    )}

    {/* TAB 2: Direct member chat */}
    {activeTab==='direct'&&(
      <section className="card">
        <h2>{t('محادثة عضو مباشر مع اختيار السيناريو والقالب','Direct Member WhatsApp')}</h2>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:'12px',marginBottom:'16px'}}>
          <label style={{margin:0}}>{t('سيناريو الرسالة والهدف منها','Message Scenario')}
            <select value={kind} onChange={e=>{
              const nextK=e.target.value as typeof kind;
              setKind(nextK);
              setTemplateId('');
            }}>
              {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label[ar?0:1]}</option>)}
            </select>
          </label>
          <label style={{margin:0}}>{t('القالب المستخدم','Template')}
            <select value={templateId} onChange={e=>setTemplateId(e.target.value)}>
              <option value="">{t('✨ القالب النموذجي المخصص للحالة: ','✨ Recommended scenario template: ')} {labels[kind][ar?0:1]}</option>
              {templates.filter(x=>x.enabled&&x.kind===kind).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        </div>

        {/* Live Scenario Preview Banner */}
        <div style={{background:'var(--surface-soft,#f8fafc)',padding:'12px 16px',borderRadius:10,marginBottom:'16px',border:'1px solid var(--line)'}}>
          <small style={{fontWeight:700,display:'block',color:'var(--purple,#7c3aed)',marginBottom:'4px'}}>
            {t('📌 نص الرسالة النموذجي المعتمد لحالة (','📌 Current default message for: ')}{labels[kind][ar?0:1]}{t('):',')')}
          </small>
          <p style={{margin:0,fontSize:'0.9rem',opacity:.9,whiteSpace:'pre-wrap',lineHeight:'1.6'}}>
            {defaultWhatsApp(kind,ar)}
          </p>
        </div>

        <div style={{display:'grid',gap:'8px'}}>
          {members.filter(m=>matchesSearch(m.name+' '+m.phone,search)).slice(0,50).map(m=>{
            const phone=m.phone;
            return <article className="preference-row" key={m.id} style={{padding:'10px 14px',borderRadius:8,border:'1px solid var(--line)',display:'flex',flexWrap:'wrap',gap:'12px',alignItems:'center',justifyContent:'space-between'}}>
              <div style={{flex:'1 1 220px',minWidth:0}}>
                <b>{m.name}</b>
                <small style={{display:'block',opacity:.75,direction:'ltr'}}><bdi>{phone}</bdi></small>
                <small style={{fontSize:'0.75rem',color:'var(--muted)'}}>{t('تاريخ الانتهاء: ','Expires: ')}{m.expires}</small>
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={()=>openComposer(m,kind,templateId||undefined)}
                style={{display:'flex',alignItems:'center',gap:'6px'}}
              >
                <span>💬</span>
                <span>{t('فتح الرسالة والخيارات','Open Message')}</span>
              </button>
            </article>;
          })}
        </div>
        <p style={{fontSize:'0.82rem',color:'var(--muted)',marginTop:'12px'}}>
          {t('استخدم مربع البحث بالأعلى للوصول الفوري للعضو؛ تعرض القائمة حتى ٥٠ نتيجة لتوفير أعلى سرعة.','Use search above to find members; up to 50 are shown for maximum performance.')}
        </p>
      </section>
    )}

    {/* TAB 3: Templates Configuration Studio */}
    {activeTab==='templates'&&(
      <section className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'10px',marginBottom:'16px',background:'var(--surface-soft,#f8fafc)',padding:'12px 16px',borderRadius:10,border:'1px solid var(--line)'}}>
          <div>
            <b style={{display:'block',fontSize:'1rem'}}>{t('تحديث وتوحيد قوالب الفرع الذكية','Sync & Upgrade Branch Templates')}</b>
            <small style={{opacity:.75}}>{t('ضبط كل قالب بنصه النموذجي المخصص لكل حالة بدلاً من النصوص العامة أو القديمة.','Set each scenario with its dedicated motivating text instead of generic text.')}</small>
          </div>
          <div style={{display:'flex',gap:'8px',flexWrap:'wrap'}}>
            <button type="button" className="button primary" disabled={busy} onClick={upgradeAllTemplatesToRecommended} style={{fontSize:'0.85rem'}}>
              {t('🔄 تحديث وضبط جميع قوالب الحالات','🔄 Reset & Upgrade Status Templates')}
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={()=>void importOccasionAndOfferPresets()} style={{fontSize:'0.85rem'}}>
              {t('🎁 إضافة قوالب الأعياد الدينية والعروض','🎁 Add Religious, Holiday & Offer Presets')}
            </button>
          </div>
        </div>

        <h2 style={{marginTop:0}}>{edit?t('✏️ تعديل قالب واتساب','✏️ Edit WhatsApp Template'):t('⚙️ إعداد وتخصيص قوالب الرسائل والمناسبات','⚙️ Configure & Customize Templates')}</h2>
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

        <h3 style={{marginBlock:'24px 12px'}}>{t('القوالب المحفوظة للفرع','Saved Branch Templates')} ({templates.length})</h3>
        <div style={{display:'grid',gap:'8px'}}>
          {templates.map(x=><article className="preference-row" key={x.id} style={{padding:'12px 16px',border:'1px solid var(--line)',borderRadius:8}}>
            <div style={{flex:1,minWidth:0}}>
              <div>
                <b>{x.name}</b>
                <span style={{fontSize:'0.75rem',marginInlineStart:'8px',padding:'2px 7px',borderRadius:6,background:'var(--surface-soft,#f1f5f9)'}}>
                  {labels[x.kind][ar?0:1]}
                </span>
                <span style={{fontSize:'0.75rem',marginInlineStart:'6px',color:x.enabled?'var(--green,#16a34a)':'var(--muted)',fontWeight:600}}>
                  {x.enabled?t('● مفعل','● Enabled'):t('○ متوقف','○ Disabled')}
                </span>
              </div>
              <p style={{fontSize:'0.83rem',opacity:.8,margin:'6px 0 2px',maxWidth:'540px',whiteSpace:'pre-wrap',lineHeight:'1.5'}}>
                {x.body.trim()===LEGACY_DUMMY_BODY?defaultWhatsApp(x.kind,ar):x.body}
              </p>
              <small style={{display:'block',opacity:.7,marginTop:'4px'}}>{t('فترة التطبيق: ','Offset: ')}{x.offset} {t('أيام','days')}</small>
            </div>
            <button className="button secondary" onClick={()=>{setEdit(x);setTemplateKind(x.kind);window.scrollTo({top:0,behavior:'smooth'});}}>
              {t('تعديل القالب','Edit')}
            </button>
          </article>)}
          {!templates.length&&<p style={{color:'var(--muted)'}}>{t('لا توجد قوالب مخصصة محفوظة بعد؛ يتم استخدام القوالب النموذجية الافتراضية المدمجة.','No custom templates yet; built-in recommended templates are used.')}</p>}
        </div>
      </section>
    )}

    {/* Send & In-App WhatsApp Dispatcher Modal */}
    {modalState&&(
      <div className="modal-backdrop" onClick={()=>setModalState(null)}>
        <div className="modal" onClick={e=>e.stopPropagation()} style={{boxSizing:'border-box',maxWidth:'min(580px, calc(100vw - 24px))',width:'100%',maxHeight:'90vh',overflowY:'auto',overflowX:'hidden'}}>
          <div className="modal-top">
            <h2 style={{margin:0,fontSize:'1.3rem'}}>
              {t('إرسال رسالة واتساب إلى: ','Send WhatsApp message to: ')}
              <span style={{color:'var(--purple,#7c3aed)'}}>{modalState.member.name}</span>
            </h2>
            <button type="button" className="button secondary" onClick={()=>setModalState(null)} style={{padding:'4px 10px'}}>✕</button>
          </div>

          <div style={{display:'flex',gap:'10px',marginBlock:'10px 16px',alignItems:'center',flexWrap:'wrap'}}>
            <span style={{background:'var(--purple-soft,#ede9fe)',color:'var(--purple,#7c3aed)',padding:'3px 8px',borderRadius:6,fontSize:'0.82rem',fontWeight:700}}>
              {labels[modalState.kind][ar?0:1]}
            </span>
            <span style={{fontSize:'0.85rem',opacity:.8}}>
              {t('الهاتف: ','Phone: ')}<b style={{direction:'ltr',display:'inline-block'}}>{modalState.member.phone}</b>
            </span>
          </div>

          <label style={{fontWeight:600}}>{t('نص الرسالة المجهز (يمكنك مراجعته أو تعديله قبل الإرسال):','Message Text (Review or customize before sending):')}
            <textarea
              value={modalState.customText}
              onChange={e=>setModalState({...modalState,customText:e.target.value})}
              style={{minHeight:'140px',fontSize:'0.95rem',lineHeight:'1.6',marginTop:'6px'}}
              maxLength={1500}
            />
          </label>

          {/* Realistic Chat Bubble Preview */}
          <div style={{background:'var(--surface-soft,#f8fafc)',padding:'12px',borderRadius:10,marginBlock:'12px',border:'1px solid var(--line)'}}>
            <small style={{fontWeight:700,display:'block',marginBottom:'6px',color:'var(--muted)'}}>
              {t('📱 معاينة الرسالة كما ستصل للعضو:','📱 Message Bubble Preview:')}
            </small>
            <div style={{
              background:'#dcf8c6',
              color:'#111827',
              padding:'10px 14px',
              borderRadius:ar?'12px 12px 0 12px':'12px 12px 12px 0',
              fontSize:'0.92rem',
              whiteSpace:'pre-wrap',
              border:'1px solid #bbf7d0',
              lineHeight:'1.5'
            }}>
              {modalState.customText}
            </div>
          </div>

          {/* Action buttons: Auto-send (WPPConnect) + App vs Web */}
          <div style={{display:'flex',flexWrap:'wrap',gap:'10px',marginTop:'18px'}}>
            {wppConnected&&(
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={()=>void sendViaWpp(modalState.member,modalState.kind,modalState.customText,modalState.templateId)}
                style={{flex:'1 1 160px',padding:'12px',fontSize:'0.92rem',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px'}}
              >
                <span>⚡</span>
                <span>{t('إرسال آلي (WPPConnect)','Auto-Send (WPPConnect)')}</span>
              </button>
            )}
            <button
              type="button"
              className="button primary"
              onClick={()=>launchWhatsApp(modalState.member.phone,modalState.customText,'app')}
              style={{flex:'1 1 160px',padding:'12px',fontSize:'0.92rem',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px'}}
            >
              <span>📲</span>
              <span>{t('فتح برنامج واتساب (المثبت)','Open WhatsApp App')}</span>
            </button>

            <button
              type="button"
              className="button secondary"
              onClick={()=>launchWhatsApp(modalState.member.phone,modalState.customText,'web')}
              style={{flex:'1 1 160px',padding:'12px',fontSize:'0.92rem',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px'}}
            >
              <span>🌐</span>
              <span>{t('فتح واتساب ويب (المتصفح)','Open WhatsApp Web')}</span>
            </button>
          </div>

          <div style={{display:'flex',justifyContent:'flex-end',marginTop:'14px'}}>
            <button type="button" className="button secondary" onClick={()=>setModalState(null)} style={{fontSize:'0.85rem'}}>
              {t('إلغاء','Cancel')}
            </button>
          </div>
        </div>
      </div>
    )}
  </section>;
}

function matchesSearch(text:string,search:string){
  const term=search.trim().toLocaleLowerCase();
  return !term||text.toLocaleLowerCase().includes(term);
}
