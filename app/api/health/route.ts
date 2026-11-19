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

        return Response.json({status: 'ready', constraints, indexes}, {headers: {'Cache-Control': 'no-store'}});
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
