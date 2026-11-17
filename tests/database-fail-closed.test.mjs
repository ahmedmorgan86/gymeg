import {test} from 'node:test';
import assert from 'node:assert/strict';
import {databaseSecurityConfig,getPool} from '../app/lib/database.ts';

test('Remote database connections verify TLS certificates and keep SSL parameters',()=>{
 const config=databaseSecurityConfig('postgresql://user:pass@db.example:6543/postgres?sslmode=require&sslrootcert=/certs/ca.crt','production');
 assert.equal(config.ssl.rejectUnauthorized,true);
 assert.ok(Array.isArray(config.ssl.ca));
 assert.equal(config.url.searchParams.get('sslmode'),'require');
 assert.equal(config.url.searchParams.get('sslrootcert'),'/certs/ca.crt');
});

test('Production refuses localhost and unconfigured databases instead of serving mock data',()=>{
 assert.throws(()=>databaseSecurityConfig('postgresql://user:pass@localhost:5432/gym','production'),/managed TLS database/);
 assert.throws(()=>databaseSecurityConfig('postgresql://user:pass@127.0.0.1:5432/gym','production'),/managed TLS database/);
 assert.doesNotThrow(()=>databaseSecurityConfig('postgresql://user:pass@localhost:5432/gym','test'));
 const previous={url:process.env.DATABASE_URL,env:process.env.NODE_ENV,mock:process.env.GYMOS_ALLOW_DB_MOCK};
 try{
  delete process.env.DATABASE_URL;process.env.NODE_ENV='production';delete process.env.GYMOS_ALLOW_DB_MOCK;
  assert.throws(()=>getPool(),/DATABASE_URL is required/);
 }finally{
  if(previous.url===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous.url;
  if(previous.env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.env;
  if(previous.mock===undefined)delete process.env.GYMOS_ALLOW_DB_MOCK;else process.env.GYMOS_ALLOW_DB_MOCK=previous.mock;
 }
});
