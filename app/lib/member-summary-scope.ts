// Snapshot scope for summary reads and refreshes. withScope (database.ts, owned by the provisioner) runs READ COMMITTED statements; a refresh needs counters, marks,
// member rows and history rows from ONE snapshot so the counters byte bound describes the rows actually read and no read skew can reach a stored row.
// A concurrent writer of the same summary row or mark surfaces as a serialization failure (40001), which the store reports as 'busy'.
import {getPool} from './database.ts';
export async function withSnapshotScope<T>(owner:string,work:(client:{query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>})=>Promise<T>):Promise<T>{
  const client=await getPool().connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);
    const result=await work(client as never);
    await client.query('COMMIT'); // after an aborted statement this is a rollback, which is what a refused refresh wants
    return result;
  }catch(e){try{await client.query('ROLLBACK');}catch{/* already closed */}throw e;}
  finally{client.release();}
}
