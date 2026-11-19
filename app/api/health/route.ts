import {getPool} from '../../lib/database';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request: Request){
  try{
    const url = new URL(request.url);
    if(url.searchParams.get('inspect') === '1'){
      const client = await getPool().connect();
      try{
        const constraints = (await client.query(`
          SELECT 
            conrelid::regclass::text AS table_name,
            conname AS constraint_name,
            contype,
            pg_get_constraintdef(c.oid) AS definition
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = 'gymos'
          ORDER BY table_name, constraint_name
        `)).rows;

        const indexes = (await client.query(`
          SELECT 
            tablename,
            indexname,
            indexdef
          FROM pg_indexes
          WHERE schemaname = 'gymos'
          ORDER BY tablename, indexname
        `)).rows;

        const testResults: Record<string, string> = {};
        const testQueries: [string, string, any[]][] = [
          ['activity_archive', "INSERT INTO gymos.gym_activity_archive(owner_id,event_id,branch,at,payload) VALUES('test','test','main',now()::text,'{}'::jsonb) ON CONFLICT(owner_id,event_id) DO NOTHING", []],
          ['gym_entities', "INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('test','members','test',0,'main','{}'::jsonb) ON CONFLICT(owner_id,collection,entity_id) DO UPDATE SET position=excluded.position", []],
          ['gym_photos', "INSERT INTO gymos.gym_photos(owner_id,member_id,content) VALUES('test','test','test') ON CONFLICT(owner_id,member_id) DO UPDATE SET content=excluded.content", []],
          ['workspace_events', "INSERT INTO gymos.workspace_events(id,owner_id,tenant_id,revision,event_type,collection,entity_id,branch,payload) VALUES('test','test','test',1,'test','test','test','main','{}'::jsonb) ON CONFLICT(owner_id,revision,id) DO NOTHING", []],
          ['membership_cards', "INSERT INTO gymos.membership_cards(code,owner_id,member_id,branch,status,payload) VALUES('TEST01','test','test','main','active','{}'::jsonb) ON CONFLICT(owner_id,code) DO NOTHING", []]
        ];

        for (const [name, sql, params] of testQueries) {
          try {
            await client.query('SAVEPOINT test_sp');
            await client.query("SELECT set_config('app.gym_owner','test',true)");
            await client.query(sql, params);
            await client.query('ROLLBACK TO SAVEPOINT test_sp');
            testResults[name] = 'OK';
          } catch (err: any) {
            try { await client.query('ROLLBACK TO SAVEPOINT test_sp'); } catch {}
            testResults[name] = err.message;
          }
        }

        return Response.json({status: 'ready', testResults, constraints, indexes}, {headers: {'Cache-Control': 'no-store'}});
      }finally{
        client.release();
      }
    }
    const r=await getPool().query("SELECT to_regclass('gymos.gym_states') IS NOT NULL AS ready");
    if(!r.rows[0]?.ready)throw Error();
    return Response.json({status:'ready'},{headers:{'Cache-Control':'no-store'}});
  }catch(e){
    console.error('database_health',e);
    return Response.json({status:'unavailable', error: e instanceof Error ? e.message : String(e)},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
