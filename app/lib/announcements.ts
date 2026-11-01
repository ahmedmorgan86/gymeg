import {z} from 'zod';
import {RuleError,type GymState,type Operation} from './domain.ts';

export const audioPartMetaSchema = z.object({
  id: z.string().min(1).max(250),
  name: z.string().min(1).max(250),
  size: z.number().int().min(0),
  duration: z.number().min(0).optional()
}).strict();

export const announcementSchema = z.object({
  id: z.string().min(1).max(250),
  branch: z.string().min(1).max(250),
  name: z.string().trim().min(1).max(250).optional(),
  // Main announcement
  mainPart: audioPartMetaSchema.optional(),
  mainVolume: z.number().int().min(0).max(100).optional(),
  mainRepeats: z.number().int().min(1).max(99).optional(),
  mainGap: z.number().int().min(0).max(3600).optional(),

  // Intro music
  beforePart: audioPartMetaSchema.optional(),
  beforeEnabled: z.boolean().optional(),
  beforeVolume: z.number().int().min(0).max(100).optional(),
  beforeRepeats: z.number().int().min(1).max(99).optional(),
  beforeGap: z.number().int().min(0).max(3600).optional(),
  beforeFadeIn: z.number().min(0).max(60).optional(),
  beforeFadeOut: z.number().min(0).max(60).optional(),

  // Outro music
  afterPart: audioPartMetaSchema.optional(),
  afterEnabled: z.boolean().optional(),
  afterVolume: z.number().int().min(0).max(100).optional(),
  afterRepeats: z.number().int().min(1).max(99).optional(),
  afterGap: z.number().int().min(0).max(3600).optional(),
  afterFadeIn: z.number().min(0).max(60).optional(),
  afterFadeOut: z.number().min(0).max(60).optional(),

  // Schedule settings
  schedule: z.enum(['daily', 'weekly', 'once', 'interval']).optional(),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).max(50).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  interval: z.number().int().min(1).max(365).optional(),

  // Optional legacy fields for backward compatibility
  text: z.string().trim().max(1000).optional(),
  lang: z.enum(['ar','en']).optional(),
  voice: z.string().max(500).optional(),
  rate: z.number().min(0.5).max(1.5).optional(),
  at: z.string().optional(),
  repeat: z.enum(["once","daily","weekly"]).optional(),
  timezone: z.string().max(100).optional(),
  priority: z.number().int().min(0).max(10).optional(),
  quiet: z.object({start:z.number().int().min(0).max(23),end:z.number().int().min(0).max(23)}).optional(),

  enabled: z.boolean()
});

export type Announcement = z.infer<typeof announcementSchema>;

export function announcementOperation(s:GymState,op:Operation,now:string,newId:()=>string){
  if(!op.type.startsWith('announcement.'))return false;
  s.announcements??=[];
  if(op.type==='announcement.remove'){
    const old=s.announcements.find(x=>x.id===op.id&&x.branch===op.branch);
    if(!old)throw new RuleError('notFound');
    s.announcements=s.announcements.filter(x=>x!==old);
    return true;
  }
  if(op.type!=='announcement.save')throw new RuleError('invalid');
  const old=op.id?s.announcements.find(x=>x.id===op.id&&x.branch===op.branch):null;
  if(op.id&&!old)throw new RuleError('notFound');

  const p=announcementSchema.safeParse({
    id:old?.id??newId(),
    branch:op.branch,
    name:op.name,
    mainPart:op.mainPart,
    mainVolume:op.mainVolume,
    mainRepeats:op.mainRepeats,
    mainGap:op.mainGap,
    beforePart:op.beforePart,
    beforeEnabled:op.beforeEnabled,
    beforeVolume:op.beforeVolume,
    beforeRepeats:op.beforeRepeats,
    beforeGap:op.beforeGap,
    beforeFadeIn:op.beforeFadeIn,
    beforeFadeOut:op.beforeFadeOut,
    afterPart:op.afterPart,
    afterEnabled:op.afterEnabled,
    afterVolume:op.afterVolume,
    afterRepeats:op.afterRepeats,
    afterGap:op.afterGap,
    afterFadeIn:op.afterFadeIn,
    afterFadeOut:op.afterFadeOut,
    schedule:op.schedule,
    days:op.days,
    times:op.times,
    date:op.date,
    startDate:op.startDate,
    endDate:op.endDate,
    interval:op.interval,
    text:op.text,
    lang:op.lang,
    voice:op.voice,
    rate:op.rate,
    at:op.at,
    repeat:op.repeat,
    timezone:s.settings.timezone,
    priority:op.priority,
    quiet:op.quiet,
    enabled:op.enabled??true
  });
  if(!p.success)throw new RuleError('invalid');
  if(p.data.enabled&&p.data.at&&p.data.at<=now)throw new RuleError('dates');
  if(old)Object.assign(old,p.data);else s.announcements.push(p.data);
  if(s.announcements.length>200)throw new RuleError('limit');
  return true;
}

function localParts(time:number,timezone:string){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time));
  const value=(key:string)=>parts.find(p=>p.type===key)?.value??'';
  return{day:value('year')+'-'+value('month')+'-'+value('day'),clock:value('hour')+':'+value('minute'),hour:Number(value('hour'))};
}

export function announcementOccurrence(a:Announcement,now:number):string|null{
  if(!a.enabled)return null;
  // If modern schedule is present
  if(a.times&&a.times.length){
    const parts=localParts(now,a.timezone??'Africa/Cairo');
    const normTimes = a.times.map(t => {
      const tr = String(t).trim();
      const [h, m] = tr.split(':');
      return h && m ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : tr;
    });
    if(!normTimes.includes(parts.clock))return null;
    if(a.startDate&&parts.day<a.startDate)return null;
    if(a.endDate&&parts.day>a.endDate)return null;
    const nowDay=new Date(now).getDay();
    if(a.schedule==='once'&&(a.date??a.startDate)!==parts.day)return null;
    if(a.schedule==='weekly'&&a.days&&!a.days.includes(nowDay))return null;
    if(a.schedule==='interval'&&a.interval&&a.startDate){
      const diff=Math.round((Date.parse(parts.day+'T12:00:00Z')-Date.parse(a.startDate+'T12:00:00Z'))/86400000);
      if(diff<0||diff%a.interval!==0)return null;
    }
    return parts.day+'T'+parts.clock;
  }
  // Fallback for legacy format if any
  if(!a.at)return null;
  const start=Date.parse(a.at);
  if(!Number.isFinite(now)||now<start)return null;
  try{
    const quietTime=localParts(now,a.timezone??'Africa/Cairo');
    if(a.quiet&&a.quiet.start!==a.quiet.end){
      const {start,end}=a.quiet;
      if(start<end?quietTime.hour>=start&&quietTime.hour<end:quietTime.hour>=start||quietTime.hour<end)return null;
    }
    if(!a.repeat||a.repeat==='once')return now-start<60000?a.at:null;
    const current=localParts(now,a.timezone??'Africa/Cairo'),first=localParts(start,a.timezone??'Africa/Cairo');
    if(current.clock!==first.clock)return null;
    const gap=Math.round((Date.parse(current.day+'T12:00:00Z')-Date.parse(first.day+'T12:00:00Z'))/86400000);
    if(gap<0||(a.repeat==='weekly'&&gap%7!==0))return null;
    return current.day+'T'+current.clock;
  }catch{return null;}
}

export function dueAnnouncement(a:Announcement,now:number,last:string|null){
  const occurrence=announcementOccurrence(a,now);
  return occurrence!==null&&occurrence!==last;
}

