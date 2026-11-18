import {Pool,type PoolClient} from 'pg';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {rootCertificates} from 'node:tls';
let pool:Pool|undefined;
const mockClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
  release: () => {},
};
const mockPool = {
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => mockClient,
  on: () => {},
} as unknown as Pool;

// A missing database must never look like a successful empty workspace.
// Mocks are available only to explicit test runs or a deliberate local opt-in.
const mockAllowed=()=>process.env.NODE_ENV==='test'||process.env.GYMOS_ALLOW_DB_MOCK==='1';
export function databaseSecurityConfig(rawUrl:string,nodeEnv=process.env.NODE_ENV){
  const url=new URL(rawUrl);
  const isLocal=url.hostname==='localhost'||url.hostname==='127.0.0.1';
  if(isLocal&&nodeEnv==='production'&&process.env.GYMOS_ALLOW_LOCAL_DB!=='1')throw new Error('Production must use a managed TLS database, not localhost');
  // pg re-parses the connection string AFTER merging our config object, so any
  // ssl-related query parameter (sslmode/ssl/sslrootcert/...) replaces the hardened
  // ssl object below with a bare `{}` — system root CAs only. The database certificate
  // is issued by a private CA (Supabase Root), so verification then always fails and
  // every request returns 503. Strip those parameters so our TLS settings always win.
  for(const param of ['sslmode','ssl','sslrootcert','sslcert','sslkey','sslnegotiation'])url.searchParams.delete(param);
  let caCert: string | undefined;
  try{caCert=readFileSync(join(process.cwd(),'certs','supabase-ca.crt'),'utf8');}
  catch(error){console.error('supabase_ca_read_failed',error instanceof Error?error.message:String(error));}
  const ssl=isLocal?undefined:{rejectUnauthorized:true,ca:caCert?[...rootCertificates,caCert]:undefined};
  return {url,ssl};
}
export function getPool(){
  if(!process.env.DATABASE_URL){
   if(mockAllowed()){console.warn('DATABASE_URL is not set — explicit test mock active');return mockPool;}
   throw new Error('DATABASE_URL is required; silent database mocks are disabled outside tests');
  }
  try{
   if(!pool){
    const {url,ssl}=databaseSecurityConfig(process.env.DATABASE_URL);
    pool=new Pool({connectionString:url.href,ssl,max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:20000,keepAlive:true,keepAliveInitialDelayMillis:10000,statement_timeout:30000,query_timeout:45000});
    pool.on('error',err=>console.error('Database connection lost',err));
    pool.on('connect',client=>client.on('error',err=>console.error('Database client error',err)));
   }
   return pool;
  }catch(err){
   if(mockAllowed()){console.warn('Database pool unavailable — explicit test mock active',err);return mockPool;}
   throw new Error('Database configuration is invalid; refusing to serve empty data',{cause:err});
  }
}
export function postgresSQL(query:string){let index=0;const ignore=/^INSERT OR IGNORE /i.test(query);let sql=query.replace(/\bgym_(states|access|invites|recovery)\b/g,'gymos.gym_$1').replace(/^INSERT OR IGNORE /i,'INSERT ').replace(/\?/g,()=>'$'+(++index));if(ignore)sql+=' ON CONFLICT DO NOTHING';return sql;}
export async function withScope<T>(owner:string,work:(client:PoolClient)=>Promise<T>):Promise<T>{let lastError:unknown;for(let attempt=0;attempt<2;attempt++){try{const client=await getPool().connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}catch(err){lastError=err;const msg=err instanceof Error?err.message:'';if(attempt===0&&(msg.includes('Connection terminated')||msg.includes('timeout')||msg.includes('ECONNRESET')||msg.includes('Connection lost')||msg.includes('503'))){await new Promise(r=>setTimeout(r,250));continue;}throw err;}}throw lastError;}
class Statement{
  readonly sql:string;readonly values:unknown[];
  constructor(sql:string,values:unknown[]=[]){this.sql=sql;this.values=values;}
  bind(...values:unknown[]){return new Statement(this.sql,values);}
  async execute(client:Pool|PoolClient=getPool()){return client.query(postgresSQL(this.sql),this.values);}
  async first<T>(owner?:string){const result=owner?await withScope(owner,client=>this.execute(client)):await this.execute();return result.rows[0] as T|null??null;}
  async all(owner?:string){const result=owner?await withScope(owner,client=>this.execute(client)):await this.execute();return {results:result.rows};}
  async run(owner?:string){const result=owner?await withScope(owner,client=>this.execute(client)):await this.execute();return {meta:{changes:result.rowCount??0}};}
}
export const db={prepare:(sql:string)=>new Statement(sql),async batch(statements:Statement[],owner?:string){let lastError:unknown;for(let attempt=0;attempt<2;attempt++){try{const client=await getPool().connect();try{await client.query('BEGIN');if(owner)await client.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);await client.query("SELECT pg_advisory_xact_lock(724396173)");const result=[];for(const statement of statements){const row=await statement.execute(client);result.push({meta:{changes:row.rowCount??0},results:row.rows});}await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}catch(err){lastError=err;const msg=err instanceof Error?err.message:'';if(attempt===0&&(msg.includes('Connection terminated')||msg.includes('timeout')||msg.includes('ECONNRESET')||msg.includes('Connection lost')||msg.includes('503'))){await new Promise(r=>setTimeout(r,250));continue;}throw err;}}throw lastError;}};
