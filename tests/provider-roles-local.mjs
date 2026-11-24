// Disposable local PostgreSQL17 acceptance only. Never accepts remote host.
import pg from 'pg';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localExtensionStubs,stripUnavailableExtensions,baseFiles,migrationFiles,readFile,migrationDir} from './db-bootstrap-helpers.mjs';
const url='postgresql://postgres@localhost:55434/rehearsal_roles';
const c=new pg.Client({connectionString:url});await c.connect();
const q=(s,v)=>c.query(s,v);
assert.deepEqual((await q("SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0],{rolsuper:false,rolbypassrls:true,rolcreaterole:true});
await q(localExtensionStubs.replace('CREATE ROLE gymos_app;CREATE ROLE anon;CREATE ROLE authenticated;',''));
for(const f of baseFiles)await q(readFile(f));
for(const n of migrationFiles){try{await q(stripUnavailableExtensions(readFileSync(new URL(n,migrationDir),'utf8')));console.log('APPLIED',n);}catch(e){console.error('FAIL',n,e.code,e.message);await c.end();process.exit(1);}}
console.log('PASS ALL',migrationFiles.length,'migrations under non-superuser provider-shaped migration principal');
await c.end();
