#!/bin/bash
set -euo pipefail
export LD_LIBRARY_PATH=/tmp/pg17-client/root/usr/lib/x86_64-linux-gnu
export PATH=/tmp/pg17-client/root/usr/lib/postgresql/17/bin:/usr/bin:/bin
base=/tmp/faithful-demand/target
mkdir -p "$base/socket"
initdb -D "$base/data" --no-locale --encoding=UTF8 --auth=trust > "$base/init.log"
cleanup(){ pg_ctl -D "$base/data" -m immediate -w stop >> "$base/server.log" 2>&1 || true; }
trap cleanup EXIT
pg_ctl -D "$base/data" -l "$base/server.log" -o "-k $base/socket -h '' -c max_worker_processes=0" -w start
export PGHOST="$base/socket" PGDATABASE=postgres PGUSER=sandbox
psql -X -v ON_ERROR_STOP=1 -c 'CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEROLE CREATEDB; CREATE ROLE gymos_app LOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; GRANT CREATE ON DATABASE postgres TO postgres;'
export PGUSER=postgres
psql -X -v ON_ERROR_STOP=1 -f /tmp/faithful-demand/baseline.sql
/usr/bin/python3 - <<'PY'
import socket
s=socket.socket();r=s.connect_ex(('1.1.1.1',443));assert r==101,r
print('NETWORK_NAMESPACE_NO_EGRESS_VERIFIED')
PY
/usr/bin/env PATH=/tmp/node24-check/node-v24.22.3-linux-x64/bin:/usr/bin:/bin /tmp/node24-check/node-v24.22.3-linux-x64/bin/node /tmp/faithful-demand/accept.mjs
