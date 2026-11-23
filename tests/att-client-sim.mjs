// Drives readAttendance exactly as app/use-attendance.ts does (first read, then `after` pages merged with mergeNewest), for differential tests.
export async function clientAttendance(scope,q,{readAttendance,mergeNewest,pickNewest}){
  const d=await readAttendance(scope,q);if(d.status==='ok')return{todayCount:d.todayCount,rows:d.rows,pages:0};
  let run=mergeNewest([...d.canonical,...d.candidates],100),next=d.next,pages=0;
  while(run&&next!==null){const pg=await readAttendance(scope,{...q,after:next,ver:d.version});if(pg.status==='stale')throw new Error('stale');if(pg.candidates.some(c=>c.pos<next.pos||(c.pos===next.pos&&c.id<=next.id)))throw new Error('cursor not advancing');run=mergeNewest([...run,...pg.candidates],100);next=pg.next;pages++;}
  return run?{todayCount:d.todayCount,rows:pickNewest(run,100),pages}:null;
}
