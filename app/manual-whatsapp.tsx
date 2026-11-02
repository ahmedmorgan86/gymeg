'use client';
import {useState,useRef,useMemo} from 'react';
import type {GymState,Operation,Member} from './lib/domain';
import {defaultWhatsApp,manualWhatsAppDue,whatsAppText,type ManualWhatsAppTemplate} from './lib/manual-whatsapp';

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

  const t=(a:string,b:string)=>ar?a:b;
  const now=new Date().toISOString();
  const members=state.members.filter(m=>m.branch===branch&&!m.archived&&!m.demo);
  const byId=useMemo(()=>new Map(members.map(m=>[m.id,m])),[members]);
  const templates=(state.manualWhatsApp??[]).filter(x=>x.branch===branch);
  const due=useMemo(()=>manualWhatsAppDue(state,branch,now),[state,branch,now]);
  const matches=(s:string)=>s.toLocaleLowerCase().includes(search.toLocaleLowerCase());
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

  function openComposer(m:Member,msgKind:ManualWhatsAppTemplate['kind'],tmplId?:string){
    const configured=templates.find(t=>t.enabled&&(tmplId?t.id===tmplId:t.kind===msgKind));
    const tmpl=configured??{body:defaultWhatsApp(msgKind,ar),name:labels[msgKind][ar?0:1]};
    const text=whatsAppText(state,m,tmpl,now);
    setModalState({member:m,kind:msgKind,templateId:tmplId,customText:text});
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
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'10px',marginBottom:'14px'}}>
          <h2 style={{margin:0}}>{t('قائمة المتابعات والتذكيرات المستحقة اليوم','Due Follow-ups & Reminders')}</h2>
          
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

        <div style={{display:'grid',gap:'10px'}}>
          {filteredDue.slice(0,60).map(x=>{
            const m=byId.get(x.member)!;
            const templateObj=templates.find(t=>t.id===x.template);
            return <article className="preference-row" key={x.member+'|'+x.template} style={{padding:'12px 16px',borderRadius:10,border:'1px solid var(--line)',background:'var(--surface)'}}>
              <div style={{flex:1,minWidth:0}}>
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
                    {whatsAppText(state,m,templateObj,now)}
                  </p>
                </details>}
              </div>

              <div style={{display:'flex',gap:'8px',flexWrap:'wrap',alignItems:'center'}}>
                <button
                  type="button"
                  className="button primary"
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
          <label style={{margin:0}}>{t('سيناريو الرسالة','Message Scenario')}
            <select value={kind} onChange={e=>{setKind(e.target.value as typeof kind);setTemplateId('');}}>
              {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label[ar?0:1]}</option>)}
            </select>
          </label>
          <label style={{margin:0}}>{t('القالب المستخدم','Template')}
            <select value={templateId} onChange={e=>setTemplateId(e.target.value)}>
              <option value="">{t('القالب النموذجي الافتراضي','Default recommended template')}</option>
              {templates.filter(x=>x.enabled&&x.kind===kind).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        </div>

        <div style={{display:'grid',gap:'8px'}}>
          {members.filter(m=>matches(m.name+' '+m.phone)).slice(0,50).map(m=>{
            const phone=m.phone;
            return <article className="preference-row" key={m.id} style={{padding:'10px 14px',borderRadius:8,border:'1px solid var(--line)'}}>
              <div>
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
          {templates.map(x=><article className="preference-row" key={x.id} style={{padding:'10px 14px',border:'1px solid var(--line)',borderRadius:8}}>
            <div>
              <b>{x.name}</b>
              <span style={{fontSize:'0.75rem',marginInlineStart:'8px',padding:'2px 7px',borderRadius:6,background:'var(--surface-soft,#f1f5f9)'}}>
                {labels[x.kind][ar?0:1]}
              </span>
              <span style={{fontSize:'0.75rem',marginInlineStart:'6px',color:x.enabled?'var(--green,#16a34a)':'var(--muted)',fontWeight:600}}>
                {x.enabled?t('● مفعل','● Enabled'):t('○ متوقف','○ Disabled')}
              </span>
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
        <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:'580px',width:'95%'}}>
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

          {/* Action buttons: App vs Web */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px',marginTop:'18px'}}>
            <button
              type="button"
              className="button primary"
              onClick={()=>launchWhatsApp(modalState.member.phone,modalState.customText,'app')}
              style={{padding:'12px',fontSize:'0.95rem',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px'}}
            >
              <span>📲</span>
              <span>{t('فتح برنامج واتساب (المثبت)','Open WhatsApp App')}</span>
            </button>

            <button
              type="button"
              className="button secondary"
              onClick={()=>launchWhatsApp(modalState.member.phone,modalState.customText,'web')}
              style={{padding:'12px',fontSize:'0.95rem',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px'}}
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
