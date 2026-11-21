import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {databaseSecurityConfig,getPool} from '../app/lib/database.ts';

test('Remote database connections verify TLS certificates and keep SSL parameters',()=>{
 const config=databaseSecurityConfig('postgresql://user:pass@db.example:6543/postgres?sslmode=require&sslrootcert=/certs/ca.crt','production');
 assert.equal(config.ssl.rejectUnauthorized,true);
 assert.ok(Array.isArray(config.ssl.ca));
 // pg re-parses the connection string after merging config: a present sslmode
 // would overwrite our ssl object with `{}` (system roots only, no Supabase CA)
 // and verification would fail, so the ssl-related parameters must be stripped.
 assert.equal(config.url.searchParams.get('sslmode'),null);
 assert.equal(config.url.searchParams.get('sslrootcert'),null);
 // The effective configuration pg will actually use keeps full verification + CA.
 const client=new pg.Client({connectionString:config.url.href,ssl:config.ssl});
 const effective=client.connectionParameters.ssl;
 assert.equal(effective.rejectUnauthorized,true);
 assert.ok(Array.isArray(effective.ca)&&effective.ca.length>1,'CA chain must survive pg connection-string parsing');
 // The bundled Supabase CA chain rides with the system roots: the pooler's
 // private-CA certificate must verify without relaxing rejectUnauthorized.
 assert.match(String(effective.ca[effective.ca.length-1]),/BEGIN CERTIFICATE/);
});

test('The Supabase CA is scoped to Supabase hosts only',()=>{
 const {rootCertificates}=process.getBuiltinModule?process.getBuiltinModule('node:tls'):require('node:tls');
 const supabase=databaseSecurityConfig('postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres','production');
 assert.ok(supabase.ssl.ca.length>1,'supabase host gets the bundled root');
 const other=databaseSecurityConfig('postgresql://u:p@db.example.com:5432/postgres','production');
 assert.equal(other.ssl.ca.length,supabase.ssl.ca.length-1,'other hosts get system roots only');
 assert.ok(!other.ssl.ca.some((c)=>String(c).includes('BEGIN CERTIFICATE')&&String(c)===String(supabase.ssl.ca[supabase.ssl.ca.length-1])));
 // Uppercase hostnames still match (PostgreSQL URL parsing preserves case).
 const upper=databaseSecurityConfig('postgresql://u:p@AWS-0-EU-CENTRAL-1.POOLER.SUPABASE.COM:5432/postgres','production');
 assert.equal(upper.ssl.ca.length,supabase.ssl.ca.length,'uppercase supabase host gets the bundled root');
 // Suffix spoofs do not: the anchor must require a real .supabase.* boundary.
 for(const spoof of ['supabase.co.evil.example','notsupabase.co','xsupabase.com']){
   const s=databaseSecurityConfig('postgresql://u:p@'+spoof+':5432/postgres','production');
   assert.equal(s.ssl.ca.length,other.ssl.ca.length,spoof+' gets system roots only');
 }
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
