'use client';
import TaskPanels from './task-panels';
import {useState,type FormEvent} from 'react';
import {dayAt,type GymState,type Operation} from './lib/domain';
import {emptyCommunity} from './lib/community';

type ConversationSection = 'unanswered' | 'today' | 'replied' | 'all' | 'new';

export default function CommunityPage({
  state,
  branch,
  ar,
  busy,
  mutate,
  initialMember
}:{
  state:GymState;
  branch:string;
  ar:boolean;
  busy:boolean;
  mutate:(op:Omit<Operation,'branch'>&{type:string})=>Promise<boolean>;
  initialMember?:string;
}){
  const [localNow]=useState(()=>{const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16);});
  const [query,setQuery]=useState('');
  const [selected,setSelected]=useState(initialMember??'');
  const [section,setSection]=useState<ConversationSection>('unanswered');
  const [notice,setNotice]=useState('');

  const t=(a:string,b:string)=>ar?a:b;
  const c=state.community??emptyCommunity();
  const members=state.members.filter(x=>x.branch===branch&&!x.demo&&!x.archived);
  const branchMessages=c.messages.filter(x=>x.branch===branch);

  const threadMap=new Map<string,typeof branchMessages>();
  for(const msg of branchMessages){
    const list=threadMap.get(msg.member)??[];
    list.push(msg);
    threadMap.set(msg.member,list);
  }

  const today=dayAt(new Date().toISOString(),state.settings.timezone);

  const threadStats=new Map<string,{lastMessage:typeof branchMessages[number];count:number;isUnanswered:boolean;isToday:boolean}>();
  for(const [memberId,msgs] of threadMap.entries()){
    const lastMsg=msgs[msgs.length-1];
    const isUnanswered=lastMsg.side==='member';
    const isToday=dayAt(lastMsg.at,state.settings.timezone)===today;
    threadStats.set(memberId,{lastMessage:lastMsg,count:msgs.length,isUnanswered,isToday});
  }

  const allThreadMembers=members.filter(m=>threadMap.has(m.id)).sort((a,b)=>{
    const tA=threadStats.get(a.id)?.lastMessage.at??'';
    const tB=threadStats.get(b.id)?.lastMessage.at??'';
    return tB.localeCompare(tA);
  });

  const unansweredMembers=allThreadMembers.filter(m=>threadStats.get(m.id)?.isUnanswered);
  const todayMembers=allThreadMembers.filter(m=>threadStats.get(m.id)?.isToday);
  const repliedMembers=allThreadMembers.filter(m=>!threadStats.get(m.id)?.isUnanswered);
  const membersWithoutThread=members.filter(m=>!threadMap.has(m.id));

  const activeSectionMembers=(
    section==='unanswered'?unansweredMembers:
    section==='today'?todayMembers:
    section==='replied'?repliedMembers:
    section==='new'?membersWithoutThread:
    allThreadMembers
  ).filter(x=>(x.name+' '+x.phone).toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  async function save(e:FormEvent<HTMLFormElement>,op:(f:FormData)=>Omit<Operation,'branch'>&{type:string}){
    e.preventDefault();
    if(busy)return;
    const form=e.currentTarget;
    try{
      if(await mutate(op(new FormData(form)))){
        form.reset();
        setNotice(t('تم الحفظ بنجاح.','Saved successfully.'));
      }
    }catch{
      setNotice(t('تعذر حفظ العملية. راجع الحقول المطلوبة.','Could not save. Check required fields.'));
    }
  }

  const selectedMember=members.find(m=>m.id===selected);
  const selectedMessages=selected?(c.messages.filter(x=>x.branch===branch&&x.member===selected)):[];

  return <section className="connect-workspace">
    <h1>{t('رسائل الأعضاء وإعلانات النادي','Member conversations & club posts')}</h1>
    <p>{t('رسائل داخل حساب العضو وإعلانات الفرع؛ لا تُرسل واتساب أو SMS تلقائيًا.','Messages inside the member account and branch announcements; no automatic WhatsApp or SMS.')}</p>

    <div className="connect-summary">
      {[
        [t('بانتظار الرد','Waiting for reply'),unansweredMembers.length],
        [t('محادثات اليوم','Today conversations'),todayMembers.length],
        [t('إجمالي المحادثات المفتوحة','Total open conversations'),allThreadMembers.length],
        [t('إعلانات الفرع الفعالة','Active announcements'),c.posts.filter(x=>x.branch===branch&&x.enabled).length]
      ].map(([label,value])=><article className="card" key={label}><b>{label}</b><h2>{value}</h2></article>)}
    </div>

    {notice&&<p className="operation-notice" role="status">{notice}</p>}

    <label>{t('بحث الأعضاء والمحادثات','Search members & conversations')}<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('ابحث بالاسم أو رقم الهاتف...','Search by name or phone...')}/></label>

    <fieldset className="workspace-permissions" disabled={busy}>
      <TaskPanels ar={ar} labels={[t("محادثات الأعضاء","Member conversations"),t("إعلانات النادي","Club announcements")]}>
        <div className="task-content">
          <section className="card">
            <h2>{t('أقسام المحادثات المفتوحة','Open conversation sections')}</h2>
            <div className="tabs standalone">
              <button type="button" className={section==='unanswered'?'selected':''} onClick={()=>setSection('unanswered')}>
                {t('بانتظار الرد','Awaiting reply')}
                <span style={unansweredMembers.length>0?{background:'#ef4444',color:'#fff',fontWeight:'bold'}:undefined}>{unansweredMembers.length}</span>
              </button>
              <button type="button" className={section==='today'?'selected':''} onClick={()=>setSection('today')}>
                {t('محادثات اليوم','Today')}
                <span>{todayMembers.length}</span>
              </button>
              <button type="button" className={section==='replied'?'selected':''} onClick={()=>setSection('replied')}>
                {t('تم الرد عليها','Replied')}
                <span>{repliedMembers.length}</span>
              </button>
              <button type="button" className={section==='all'?'selected':''} onClick={()=>setSection('all')}>
                {t('كل المحادثات المفتوحة','All open')}
                <span>{allThreadMembers.length}</span>
              </button>
              <button type="button" className={section==='new'?'selected':''} onClick={()=>setSection('new')}>
                {t('بدء محادثة جديدة','New chat')}
                <span>{membersWithoutThread.length}</span>
              </button>
            </div>

            <label>{t('اختيار سريع للعضو','Quick member selector')}
              <select value={selected} onChange={e=>setSelected(e.target.value)}>
                <option value="">{t('اختر عضوًا لفتح المحادثة والرد...','Choose a member to open conversation...')}</option>
                {activeSectionMembers.slice(0,100).map(x=><option key={x.id} value={x.id}>
                  {x.name} {threadStats.get(x.id)?.isUnanswered?' · 🔴 (بانتظار الرد)':threadMap.has(x.id)?' · 💬':''}
                </option>)}
              </select>
            </label>

            <div style={{display:'grid',gap:'8px',maxHeight:320,overflowY:'auto',marginBlock:'12px'}}>
              {activeSectionMembers.slice(0,50).map(m=>{
                const stat=threadStats.get(m.id);
                const isCur=selected===m.id;
                return <div
                  key={m.id}
                  onClick={()=>setSelected(m.id)}
                  style={{
                    cursor:'pointer',
                    padding:'10px 14px',
                    borderRadius:8,
                    border:isCur?'2px solid var(--purple,#8b5cf6)':'1px solid var(--line)',
                    background:isCur?'var(--purple-soft,#f5f3ff)':'var(--surface)',
                    display:'flex',
                    justifyContent:'space-between',
                    alignItems:'center',
                    gap:'12px'
                  }}
                >
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'3px',flexWrap:'wrap'}}>
                      <b>{m.name}</b>
                      <small style={{opacity:.7}}>{m.phone}</small>
                      {stat?.isUnanswered?(
                        <span style={{fontSize:'0.72rem',padding:'2px 7px',borderRadius:6,background:'#fee2e2',color:'#b91c1c',fontWeight:700}}>
                          {t('بانتظار الرد','Needs reply')}
                        </span>
                      ):stat?(
                        <span style={{fontSize:'0.72rem',padding:'2px 7px',borderRadius:6,background:'#dcfce7',color:'#15803d',fontWeight:700}}>
                          {t('تم الرد','Replied')}
                        </span>
                      ):null}
                    </div>
                    {stat?.lastMessage&&(
                      <p style={{margin:0,fontSize:'0.85rem',opacity:.85,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                        <bdi>{stat.lastMessage.side==='member'?(t('العضو: ','Member: ')):(t('النادي: ','Club: '))}</bdi>
                        {stat.lastMessage.text}
                      </p>
                    )}
                  </div>
                  <div style={{textAlign:ar?'left':'right',flexShrink:0}}>
                    {stat?.lastMessage&&<small style={{fontSize:'0.75rem',opacity:.65}}>
                      {new Date(stat.lastMessage.at).toLocaleTimeString(ar?'ar-EG':'en-GB',{hour:'2-digit',minute:'2-digit'})}
                    </small>}
                  </div>
                </div>;
              })}
              {!activeSectionMembers.length&&<p style={{textAlign:'center',padding:'20px',opacity:.7}}>{t('لا توجد محادثات في هذا القسم حاليًا.','No conversations in this section currently.')}</p>}
            </div>

            {selected&&selectedMember&&<section className="card" style={{marginTop:'18px',borderTop:'2px solid var(--purple,#8b5cf6)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:'1px solid var(--line)',paddingBottom:'10px',marginBottom:'14px'}}>
                <div>
                  <h3 style={{margin:0}}>{selectedMember.name}</h3>
                  <small style={{opacity:.75}}>{selectedMember.phone}</small>
                </div>
                <button className="button secondary" type="button" onClick={()=>setSelected('')}>{t('إغلاق المحادثة','Close chat')}</button>
              </div>

              <div style={{maxHeight:360,overflowY:'auto',display:'flex',flexDirection:'column',gap:'10px',padding:'6px',marginBottom:'14px'}}>
                {!selectedMessages.length&&<p style={{textAlign:'center',opacity:.7}}>{t('لا توجد رسائل سابقة. ابدأ المحادثة بكتابة رسالة للعضو.','No previous messages. Start conversation by writing to the member.')}</p>}
                {selectedMessages.map(x=><article
                  key={x.id}
                  style={{
                    alignSelf:x.side==='member'?'flex-start':'flex-end',
                    maxWidth:'85%',
                    padding:'10px 14px',
                    borderRadius:12,
                    background:x.side==='member'?'var(--surface-soft,#f1f5f9)':'var(--purple-soft,#ede9fe)',
                    border:'1px solid var(--line)'
                  }}
                >
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:'12px',marginBottom:'4px'}}>
                    <b style={{fontSize:'0.85rem',color:x.side==='member'?'var(--text)':'var(--purple,#7c3aed)'}}>
                      {x.side==='member'?selectedMember.name.split(' / ')[0]:(x.actor||t('إدارة النادي','Club team'))}
                    </b>
                    <small style={{fontSize:'0.7rem',opacity:.65}}>{new Date(x.at).toLocaleString(ar?'ar-EG':'en-GB')}</small>
                  </div>
                  <p style={{margin:0,whiteSpace:'pre-wrap'}}>{x.text}</p>
                </article>)}
              </div>

              <form onSubmit={e=>void save(e,f=>({type:'community.reply',member:selected,text:f.get('text')}))}>
                <label>{t('الرد أو إرسال رسالة للعضو','Reply or message the member')}
                  <textarea name="text" required maxLength={2000} placeholder={t('اكتب نص الرد هنا...','Write reply text here...')}/>
                </label>
                <button className="button primary">{t('حفظ الرد للعضو','Save reply for member')}</button>
              </form>
            </section>}
          </section>
        </div>

        <div className="task-content">
          <details className="card">
            <summary>{t('إعلان جديد للفرع','New branch announcement')}</summary>
            <form onSubmit={e=>void save(e,f=>({type:'community.post',title:f.get('title'),body:f.get('body'),publishAt:new Date(String(f.get('publishAt'))).toISOString(),expiresAt:f.get('expiresAt')?new Date(String(f.get('expiresAt'))).toISOString():undefined,enabled:f.get('enabled')==='on'}))}>
              <label>{t('العنوان','Title')}<input name="title" maxLength={150} required/></label>
              <label>{t('النص','Text')}<textarea name="body" maxLength={2000} required/></label>
              <div className="form-row">
                <label>{t('موعد الظهور — توقيت جهازك','Publish — your device timezone')}<input name="publishAt" type="datetime-local" defaultValue={localNow} required/></label>
                <label>{t('انتهاء العرض — اختياري','Hide after — optional')}<input name="expiresAt" type="datetime-local"/></label>
              </div>
              <label className="checkbox"><input name="enabled" type="checkbox" defaultChecked/>{t('فعال','Enabled')}</label>
              <button className="button primary">{t('حفظ الإعلان','Save announcement')}</button>
            </form>
          </details>

          <section className="card">
            <h2>{t('إعلانات الفرع','Branch announcements')}</h2>
            {c.posts.filter(x=>x.branch===branch).slice(-50).reverse().map(x=><article className="card" key={x.id}>
              <h3>{x.title}</h3>
              <p style={{whiteSpace:'pre-wrap'}}>{x.body}</p>
              <small>{new Date(x.publishAt).toLocaleString(ar?'ar-EG':'en-GB')}</small>
              <button className="button secondary" onClick={()=>void mutate({type:'community.post',...x,enabled:!x.enabled})}>
                {x.enabled?t('إيقاف العرض','Hide'):t('إعادة التفعيل','Enable')}
              </button>
            </article>)}
          </section>
        </div>
      </TaskPanels>
    </fieldset>
  </section>;
}
