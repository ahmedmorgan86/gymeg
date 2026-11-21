// Bounded read for the Attendance page: the branch's check-ins today (ALL of the branch's visits of that day, as the page counts them) and the newest ATTENDANCE_ROWS visits
// in the page's order `b.day.localeCompare(a.day)||b.at.localeCompare(a.at)` (stable, so ties keep position order). Code-point order equals localeCompare only for canonical
// day/at strings, so any irregular value in the branch returns {status:'fallback'} and the page keeps the legacy path.
import {boundedRead} from './bounded-read.ts';
import type {Scope} from './member-console-source.ts';
export const ATTENDANCE_ROWS=100;
export type AttendanceKey={id:string;day:unknown;at:unknown};
export type AttendanceData={status:'ok';todayCount:number;rows:Record<string,unknown>[]}|{status:'irregular';todayCount:number;keys:AttendanceKey[]};
export async function readAttendance(scope:Scope,q:{owner:string;branch:string;day:string}):Promise<AttendanceData>{
  if(!q.branch||q.branch.length>200||!/^\d{4}-\d\d-\d\d$/.test(q.day))throw new RangeError('invalid');
  return scope(q.owner,c=>boundedRead(c,q.owner,'att\u0000'+q.branch+'\u0000'+q.day,async()=>{
    const irregular=(await c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND (jsonb_typeof(payload->'day') IS DISTINCT FROM 'string' OR payload->>'day' !~ '^\\d{4}-\\d\\d-\\d\\d$' OR jsonb_typeof(payload->'at') IS DISTINCT FROM 'string' OR payload->>'at' !~ '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$')) AS x`,[q.owner,q.branch])).rows[0] as {x:boolean};
    const todayCount=Number(((await c.query("SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND payload->>'day'=$3",[q.owner,q.branch,q.day])).rows[0] as {n:number}).n);
    if(irregular.x){
      // Some day/at is not canonical, so only the browser's own localeCompare is exact: return the branch's (id,day,at) in position order and let the page sort, then fetch the 100 rows by id.
      const keys=(await c.query("SELECT entity_id AS id,payload->'day' AS day,payload->'at' AS at FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 ORDER BY position,entity_id",[q.owner,q.branch])).rows as AttendanceKey[];
      return{status:'irregular',todayCount,keys} as const;
    }
    const rows=(await c.query(`SELECT payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 ORDER BY (payload->>'day') COLLATE "C" DESC,(payload->>'at') COLLATE "C" DESC,position ASC,entity_id ASC LIMIT ${ATTENDANCE_ROWS}`,[q.owner,q.branch])).rows.map(r=>(r as {payload:Record<string,unknown>}).payload);
    return{status:'ok',todayCount,rows} as const;
  }));
}
/** The 100 rows chosen by the page (ids from its own sort) for an irregular branch; order preserved, ids outside the branch's visits are ignored. */
export async function readVisitsByIds(scope:Scope,q:{owner:string;branch:string;ids:string[]}):Promise<Record<string,unknown>[]>{
  if(!q.branch||q.ids.length>ATTENDANCE_ROWS||q.ids.some(i=>!i||i.length>200))throw new RangeError('invalid');
  if(!q.ids.length)return[];
  return scope(q.owner,async c=>{
    await c.query("SELECT set_config('statement_timeout','2000',true)");
    const rows=(await c.query("SELECT entity_id AS id,payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND entity_id=ANY($3::text[])",[q.owner,q.branch,q.ids])).rows as {id:string;payload:Record<string,unknown>}[];
    const by=new Map(rows.map(r=>[r.id,r.payload]));return q.ids.flatMap(i=>by.has(i)?[by.get(i)!]:[]);
  });
}
