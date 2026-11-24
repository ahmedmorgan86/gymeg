#!/bin/bash
set -euo pipefail
export LD_LIBRARY_PATH=/tmp/pg17-client/root/usr/lib/x86_64-linux-gnu
export PATH=/tmp/pg17-client/root/usr/lib/postgresql/17/bin:/usr/bin:/bin
base=/tmp/held-demand-runner/target
mkdir -p "$base/socket"
initdb -D "$base/data" --no-locale --encoding=UTF8 --auth=trust > "$base/init.log"
cleanup(){ pg_ctl -D "$base/data" -m immediate -w stop >> "$base/server.log" 2>&1 || true; }
trap cleanup EXIT
pg_ctl -D "$base/data" -l "$base/server.log" -o "-k $base/socket -h '' -c max_worker_processes=0" -w start
export PGHOST="$base/socket" PGDATABASE=postgres PGUSER=sandbox
psql -X -v ON_ERROR_STOP=1 -c 'CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEROLE CREATEDB; CREATE ROLE gymos_app LOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA gymos AUTHORIZATION postgres; GRANT CREATE ON DATABASE postgres TO postgres;'
export PGUSER=postgres
psql -X -v ON_ERROR_STOP=1 -f /tmp/support-isolated-adapter/db/postgres.sql
psql -X -v ON_ERROR_STOP=1 -f /tmp/support-isolated-adapter/db/entities.sql
psql -X -v ON_ERROR_STOP=1 -c "INSERT INTO gymos.gym_states VALUES('synthetic-runner-a','{\"schema\":1,\"settings\":{},\"branches\":[],\"_entityStorage\":1}',0,now()::text); INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('synthetic-runner-a','members','m','main','{\"id\":\"m\",\"branch\":\"main\",\"name\":\"Synthetic Member\"}');"
psql -X -v ON_ERROR_STOP=1 -f /tmp/held-demand-runner/01-schema-held.sql
psql -X -v ON_ERROR_STOP=1 -f /tmp/held-demand-runner/02-indexes-held.sql
psql -X -v ON_ERROR_STOP=1 -At -c "SELECT current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),count(*) FROM pg_attribute WHERE attrelid='gymos.gym_entities'::regclass AND attnum>0 AND NOT attisdropped; SELECT count(*) FROM pg_index WHERE indrelid IN('gymos.gym_entities'::regclass,'gymos.invoice_allocation_refs'::regclass) AND NOT indisvalid;"

PGUSER=gymos_app psql -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.gym_owner','synthetic-runner-a',true);
INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('synthetic-runner-a','invoices','i','main','{"id":"i","branch":"main","member":"m","allocations":[{"payment":"p","minor":100}]}');
COMMIT;
BEGIN;
SELECT set_config('app.gym_owner','synthetic-runner-b',true);
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id='synthetic-runner-a') THEN RAISE EXCEPTION 'foreign entity leaked'; END IF;
 IF EXISTS(SELECT 1 FROM gymos.invoice_allocation_refs WHERE owner_id='synthetic-runner-a') THEN RAISE EXCEPTION 'foreign refs leaked'; END IF;
 BEGIN
  INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('synthetic-runner-a','members','forged','main','{}');
  RAISE EXCEPTION 'foreign write accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END$$;
ROLLBACK;
SQL
psql -X -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT count(*) FROM gymos.invoice_allocation_refs WHERE owner_id='synthetic-runner-a' AND invoice_id='i' AND payment_id='p';
BEGIN;
INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('synthetic-runner-a','members','rolledback','main','{}');
ROLLBACK;
SELECT count(*) FROM gymos.gym_entities WHERE entity_id='rolledback';
SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname='gymos_refs_maint';
SQL
psql -X -v ON_ERROR_STOP=1 -f /tmp/held-demand-runner/03-rollback-held.sql
psql -X -v ON_ERROR_STOP=1 -At -c "SELECT count(*) FROM pg_attribute WHERE attrelid='gymos.gym_entities'::regclass AND attnum>0 AND NOT attisdropped; SELECT owner_id,collection,entity_id,payload FROM gymos.gym_entities; SELECT count(*) FROM pg_roles WHERE rolname='gymos_refs_maint';"
