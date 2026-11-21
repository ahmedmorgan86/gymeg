// Bounded read for the Attendance page: the branch's check-ins today (ALL of the branch's visits of that day, as the page counts them) and the newest ATTENDANCE_ROWS visits
// in the page's order `b.day.localeCompare(a.day)||b.at.localeCompare(a.at)` (stable, so ties keep position order). Code-point order equals localeCompare only for canonical
// day/at strings. A branch holding any non-canonical value is answered exactly by a candidate merge: the canonical top 100, plus the non-canonical rows streamed in position-ordered pages of IRREGULAR_PAGE that the browser merges into a running top 100 with its own comparator. No row limit: transfer is proportional to the non-canonical rows only.
import {boundedRead,indexProbe} from './bounded-read.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import type {Scope} from './member-console-source.ts';
export const ATTENDANCE_ROWS=100;
export type Cand={p:Record<string,unknown>;pos:number;id:string};
export type Cursor={pos:number;id:string};
export type AttendanceData={status:'ok';todayCount:number;rows:Record<string,unknown>[]}|{status:'irregular';version:string;todayCount?:number;canonical:Cand[];candidates:Cand[];next:Cursor|null}|{status:'stale'}|{status:'unavailable'};
/** Transfer chunk for non-canonical rows. A page size, not a limit: the browser keeps asking until `next` is null. Judgment, not derived. */
export const IRREGULAR_PAGE=500;
export async function readAttendance(scope:Scope,q:{owner:string;branch:string;day:string;after?:Cursor;ver?:string}):Promise<AttendanceData>{
  if(!q.branch||q.branch.length>200||!/^\d{4}-\d\d-\d\d$/.test(q.day)||(q.after!==undefined&&(!Number.isSafeInteger(q.after.pos)||!q.after.id||q.after.id.length>200||typeof q.ver!=='string')))throw new RangeError('invalid');
  return scope(q.owner,c=>boundedRead(c,q.owner,'att\u0000'+q.branch+'\u0000'+q.day+'\u0000'+(q.after?q.after.pos+'\u0000'+q.after.id+'\u0000'+q.ver:''),async()=>{
    const ver0=await readOwnerVersion(c,q.owner); // read BEFORE the irregular probe: the regular path rechecks it after its rows
    const irregular=(await indexProbe(c,()=>c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND branch=$2 AND visit_odd) AS x`,[q.owner,q.branch]))).rows[0] as {x:boolean};
    const CANON=`collection='visits' AND NOT visit_odd`;
    const ODD=`visit_odd`;
    const paging=q.after!==undefined;
    if(irregular.x||paging){
      // Every page of one answer must come from one owner version: pages carry the version they were read at, and a page whose version moved (before, during or after its read) answers 'stale' so the browser restarts.
      const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable'} as const;if(paging&&q.ver!==ver)return{status:'stale'} as const;
      const todayCount=paging?undefined:Number(((await c.query("SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND demand_visit_day IS NOT NULL AND demand_visit_day=($3::text COLLATE \"C\")",[q.owner,q.branch,q.day])).rows[0] as {n:number}).n);
      const top=paging?[]:(await c.query(`SELECT payload,position,entity_id FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND ${CANON} ORDER BY demand_visit_day DESC,visit_at DESC,position ASC,entity_id ASC LIMIT ${ATTENDANCE_ROWS}`,[q.owner,q.branch])).rows as {payload:Record<string,unknown>;position:number;entity_id:string}[];
      // Steer the planner to the partial index (key owner,branch,position) for this statement only: with LIMIT it otherwise scans the whole branch in position order (~51k buffers measured).
      await c.query("SELECT set_config('enable_seqscan','off',true)");
      const odd=(await c.query(`SELECT payload,position,entity_id FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND (position,entity_id)>($3::bigint,$4::text) AND ${ODD} ORDER BY position,entity_id LIMIT ${IRREGULAR_PAGE+1}`,[q.owner,q.branch,q.after?.pos??-1,q.after?.id??''])).rows as {payload:Record<string,unknown>;position:number;entity_id:string}[];
      await c.query("SELECT set_config('enable_seqscan','on',true)");
      const more=odd.length>IRREGULAR_PAGE,page=more?odd.slice(0,IRREGULAR_PAGE):odd;
      const cand=(r:{payload:Record<string,unknown>;position:number;entity_id:string}):Cand=>({p:r.payload,pos:Number(r.position),id:r.entity_id});
      if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
      return{status:'irregular',version:ver,...(todayCount!==undefined?{todayCount}:{}),canonical:top.map(cand),candidates:page.map(cand),next:more?{pos:Number(page[page.length-1].position),id:page[page.length-1].entity_id}:null} as const;
    }
    const todayCount=Number(((await c.query("SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND demand_visit_day IS NOT NULL AND demand_visit_day=($3::text COLLATE \"C\")",[q.owner,q.branch,q.day])).rows[0] as {n:number}).n);
    const rows=(await c.query(`SELECT payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND ${CANON} ORDER BY demand_visit_day DESC,visit_at DESC,position ASC,entity_id ASC LIMIT ${ATTENDANCE_ROWS}`,[q.owner,q.branch])).rows.map(r=>(r as {payload:Record<string,unknown>}).payload);
    if(ver0!==null&&(await readOwnerVersion(c,q.owner))!==ver0)return{status:'stale'} as const; // (no version token: the branch pages already answer unavailable; this path keeps its previous behavior) a writer between the irregular probe and these rows could have made a row non-canonical (and so omitted above)
    return{status:'ok',todayCount,rows} as const;
  },o=>o.status==='ok'||o.status==='irregular'));
}