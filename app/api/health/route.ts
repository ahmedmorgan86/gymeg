import {getPool} from '../../lib/database';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request: Request){
  try{
    const url = new URL(request.url);
    if(url.searchParams.get('fix') === '1'){
      const client = await getPool().connect();
      try{
        await client.query(`
          CREATE OR REPLACE FUNCTION gymos.sync_membership_cards() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,gymos AS $$
          DECLARE c jsonb; holder gymos.membership_cards%ROWTYPE; records jsonb; active_code text;
          BEGIN
           IF NEW.collection<>'members' THEN RETURN NEW; END IF;
           active_code:=nullif(NEW.payload->>'card','');records:=coalesce(NEW.payload->'cards','[]'::jsonb);
           IF active_code IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(records) x WHERE x->>'code'=active_code) THEN records:=records||jsonb_build_array(jsonb_build_object('code',active_code,'status','active','issuedAt',null,'history','[]'::jsonb)); END IF;
           IF (SELECT count(*) FROM jsonb_array_elements(records) x WHERE x->>'status'='active')>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(records) x WHERE (x->>'status'='active') IS DISTINCT FROM coalesce(x->>'code'=active_code,false)) THEN RAISE EXCEPTION 'Invalid active card projection' USING ERRCODE='23514'; END IF;
           IF (SELECT count(*) FROM jsonb_array_elements(records))<>(SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(records) x) THEN RAISE EXCEPTION 'Duplicate card history' USING ERRCODE='23514'; END IF;
           UPDATE gymos.membership_cards SET status='replaced' WHERE owner_id=NEW.owner_id AND member_id=NEW.entity_id AND status='active' AND code IS DISTINCT FROM active_code;
           FOR c IN SELECT value FROM jsonb_array_elements(records) LOOP
            SELECT * INTO holder FROM gymos.membership_cards WHERE owner_id=NEW.owner_id AND code=c->>'code' FOR UPDATE;
            IF FOUND AND (holder.owner_id<>NEW.owner_id OR holder.member_id<>NEW.entity_id) THEN RAISE EXCEPTION 'Barcode already used' USING ERRCODE='23505'; END IF;
            INSERT INTO gymos.membership_cards(code,owner_id,member_id,branch,status,payload) VALUES(c->>'code',NEW.owner_id,NEW.entity_id,NEW.branch,c->>'status',c)
             ON CONFLICT(owner_id,code) DO UPDATE SET status=excluded.status,payload=excluded.payload,branch=excluded.branch WHERE membership_cards.owner_id=excluded.owner_id AND membership_cards.member_id=excluded.member_id;
            IF NOT FOUND THEN RAISE EXCEPTION 'Barcode ownership conflict' USING ERRCODE='23505'; END IF;
           END LOOP;
           RETURN NEW;
          END $$;
        `);
        return Response.json({status: 'fixed'}, {headers: {'Cache-Control': 'no-store'}});
      }finally{
        client.release();
      }
    }
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
          ['gym_entities_recordset', "INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'test',x.collection,x.entity_id,x.position,x.branch,x.payload FROM jsonb_to_recordset('[{\"collection\":\"members\",\"entity_id\":\"test-m\",\"position\":0,\"branch\":\"main\",\"payload\":{\"id\":\"test-m\",\"name\":\"Test Member\",\"card\":\"20261119-9999\",\"cards\":[{\"code\":\"20261119-9999\",\"status\":\"active\"}]}}]'::jsonb) AS x(collection text,entity_id text,position integer,branch text,payload jsonb) ON CONFLICT(owner_id,collection,entity_id) DO UPDATE SET position=excluded.position,branch=excluded.branch,payload=excluded.payload", []],
          ['gym_entities_invoices', "INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'test',x.collection,x.entity_id,x.position,x.branch,x.payload FROM jsonb_to_recordset('[{\"collection\":\"invoices\",\"entity_id\":\"inv-1\",\"position\":0,\"branch\":\"main\",\"payload\":{\"id\":\"inv-1\"}}]'::jsonb) AS x(collection text,entity_id text,position integer,branch text,payload jsonb) ON CONFLICT(owner_id,collection,entity_id) DO UPDATE SET position=excluded.position,branch=excluded.branch,payload=excluded.payload", []],
          ['gym_entities_members_no_cards', "INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'test',x.collection,x.entity_id,x.position,x.branch,x.payload FROM jsonb_to_recordset('[{\"collection\":\"members\",\"entity_id\":\"test-m2\",\"position\":0,\"branch\":\"main\",\"payload\":{\"id\":\"test-m2\",\"name\":\"No Cards\"}}]'::jsonb) AS x(collection text,entity_id text,position integer,branch text,payload jsonb) ON CONFLICT(owner_id,collection,entity_id) DO UPDATE SET position=excluded.position,branch=excluded.branch,payload=excluded.payload", []],
          ['gym_photos', "INSERT INTO gymos.gym_photos(owner_id,member_id,content) VALUES('test','test','test') ON CONFLICT(owner_id,member_id) DO UPDATE SET content=excluded.content", []],
          ['workspace_events', "INSERT INTO gymos.workspace_events(id,owner_id,tenant_id,revision,event_type,collection,entity_id,branch,payload) VALUES('test','test','test',1,'test','test','test','main','{}'::jsonb) ON CONFLICT(owner_id,revision,id) DO NOTHING", []],
          ['membership_cards', "INSERT INTO gymos.membership_cards(code,owner_id,member_id,branch,status,payload) VALUES('TEST01','test','test','main','active','{}'::jsonb) ON CONFLICT(owner_id,code) DO NOTHING", []]
        ];

        for (const [name, sql, params] of testQueries) {
          try {
            await client.query('BEGIN');
            await client.query("SELECT set_config('app.gym_owner','test',true)");
            await client.query(sql, params);
            await client.query('ROLLBACK');
            testResults[name] = 'OK';
          } catch (err: any) {
            try { await client.query('ROLLBACK'); } catch {}
            testResults[name] = err.message;
          }
        }

        const triggerSrc = (await client.query(`
          SELECT p.proname, p.prosrc
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'gymos' AND p.proname IN ('sync_membership_cards', 'sync_member_codes', 'sync_member_code_accounts')
        `)).rows;

        return Response.json({status: 'ready', testResults, triggerSrc, constraints, indexes}, {headers: {'Cache-Control': 'no-store'}});
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
