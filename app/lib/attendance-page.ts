// Bounded read for the Attendance page: the branch's check-ins today (ALL of the branch's visits of that day, as the page counts them) and the newest ATTENDANCE_ROWS visits
// in the page's order `b.day.localeCompare(a.day)||b.at.localeCompare(a.at)` (stable, so ties keep position order). Code-point order equals localeCompare only for canonical
// day/at strings, so any irregular value in the branch returns {status:'fallback'} and the page keeps the legacy path.
import {boundedRead} from './bounded-read.ts';
import type {Scope} from './member-console-source.ts';
export const ATTENDANCE_ROWS=100;
export type AttendanceData={status:'ok';todayCount:number;rows:Record<string,unknown>[]}|{status:'irregular';todayCount:number;candidates:Record<string,unknown>[]}|{status:'capped';reason:string};
/** Most non-canonical visits one branch may hold for the exact candidate merge. A product-neutral safety bound, my judgment (the merge returns at most this many plus 100 rows); above it the page shows its failure state with Retry. */
export const IRREGULAR_MAX=500;
export async function readAttendance(scope:Scope,q:{owner:string;branch:string;day:string}):Promise<AttendanceData>{
  if(!q.branch||q.branch.length>200||!/^\d{4}-\d\d-\d\d$/.test(q.day))throw new RangeError('invalid');
  return scope(q.owner,c=>boundedRead(c,q.owner,'att\u0000'+q.branch+'\u0000'+q.day,async()=>{
    const irregular=(await c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND (jsonb_typeof(payload->'day') IS DISTINCT FROM 'string' OR payload->>'day' !~ '^\\d{4}-\\d\\d-\\d\\d$' OR jsonb_typeof(payload->'at') IS DISTINCT FROM 'string' OR payload->>'at' !~ '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$')) AS x`,[q.owner,q.branch])).rows[0] as {x:boolean};
    const todayCount=Number(((await c.query("SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND payload->>'day'=$3",[q.owner,q.branch,q.day])).rows[0] as {n:number}).n);
    const CANON=`jsonb_typeof(payload->'day')='string' AND payload->>'day' ~ '^\\d{4}-\\d\\d-\\d\\d$' AND jsonb_typeof(payload->'at')='string' AND payload->>'at' ~ '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$'`;
    // ODD is written exactly as the held partial index gym_entities_visit_irregular_dayat predicate so the planner can use it (a NOT(CANON) form seq-scans: ~51k buffers measured).
    const ODD=`jsonb_typeof(payload->'day') IS DISTINCT FROM 'string' OR payload->>'day' !~ '^\\d{4}-\\d\\d-\\d\\d$' OR jsonb_typeof(payload->'at') IS DISTINCT FROM 'string' OR payload->>'at' !~ '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$'`;
    const top=(await c.query(`SELECT payload,position FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2${irregular.x?' AND '+CANON:''} ORDER BY (payload->>'day') COLLATE "C" DESC,(payload->>'at') COLLATE "C" DESC,position ASC,entity_id ASC LIMIT ${ATTENDANCE_ROWS}`,[q.owner,q.branch])).rows as {payload:Record<string,unknown>;position:number}[];
    if(irregular.x){
      // Exact merge: canonical rows keep one total order that equals the page's localeCompare order (the top 100 of them suffice), and the non-canonical rows are all returned; the page
      // sorts this candidate set with its own comparator. Candidates come back in position order so ties keep the legacy stable order.
      // With LIMIT the planner prefers a position-order scan of the whole branch (~51k buffers measured); steer it to the partial index for this one statement only.
      await c.query("SELECT set_config('enable_seqscan','off',true)");
      const odd=(await c.query(`SELECT payload,position FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND (${ODD}) LIMIT ${IRREGULAR_MAX+1}`,[q.owner,q.branch])).rows as {payload:Record<string,unknown>;position:number}[];
      await c.query("SELECT set_config('enable_seqscan','on',true)");
      if(odd.length>IRREGULAR_MAX)return{status:'capped',reason:'too-many-non-canonical-visits'} as const;
      const all=[...top,...odd].sort((a,b)=>Number(a.position)-Number(b.position));
      return{status:'irregular',todayCount,candidates:all.map(r=>r.payload)} as const;
    }
    const rows=top.map(r=>r.payload);
    return{status:'ok',todayCount,rows} as const;
  }));
}
