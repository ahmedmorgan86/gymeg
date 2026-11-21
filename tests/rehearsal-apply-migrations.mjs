import pg from 'pg';
import {localExtensionStubs,stripUnavailableExtensions,baseFiles,migrationFiles,readFile,migrationDir} from '../tests/db-bootstrap-helpers.mjs';
import {readFileSync} from 'node:fs';
const c=new pg.Client({connectionString:process.env.REHEARSAL_DATABASE_URL});await c.connect();
// roles are cluster-wide: tolerate re-runs on a second rehearsal_ database
await c.query(localExtensionStubs.replace('CREATE ROLE gymos_app;CREATE ROLE anon;CREATE ROLE authenticated;',()=>"DO $$ BEGIN CREATE ROLE gymos_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;"));
for(const f of baseFiles)await c.query(readFile(f));
for(const n of migrationFiles){try{await c.query(stripUnavailableExtensions(readFileSync(new URL(n,migrationDir),'utf8')));}catch(e){console.log('FAIL',n,e.message);process.exit(1);}}
console.log('applied',migrationFiles.length);await c.end();
