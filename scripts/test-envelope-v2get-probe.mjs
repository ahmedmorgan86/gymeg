// v2 GET envelope probe: the legacy download path hydrates the full state (photos inline),
// merges the ENTIRE activity archive, then serializes one JSON body. Measures each stage's
// process memory/time at representative scale. Observational samples, 5ms peak sampling.
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {getPool,withScope} from '../app/lib/database.ts';
import {emptyState,applyOperation} from '../app/lib/domain.ts';
import {persistSpace,readEntitySpace} from '../app/lib/entity-store.ts';
import {archivedEvents} from '../app/lib/activity-archive.ts';

const owner='gymos-env-v2-'+randomUUID();
const admin=new pg.Client(process.env.DATABASE_URL_ADMIN||process.env.DATABASE_URL);await admin.connect();
const N=Number(process.env.ENVELOPE_N||250),SIZE=96000,EVENTS=Number(process.env.ENVELOPE_EVENTS||90000);
const jpeg=(n,salt)=>('data:image/jpeg;base64,/9j/'+salt+'A'.repeat(n)).slice(0,n);
const mem=()=>{const m=process.memoryUsage();return Math.round((m.heapUsed+m.external)/1048576);};
let peak=0;const t=setInterval(()=>{const m=mem();if(m>peak)peak=m;},5);
try{
 let state=emptyState();
 for(let i=0;i<N;i+=1)state=applyOperation(state,{type:'member.save',branch:'main',name:'M'+i,phone:'',joined:'2026-10-01',expires:'2026-11-01'},'2026-10-18T12:00:00Z','T',randomUUID);
 await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,0,$3)',[owner,JSON.stringify(emptyState()),new Date().toISOString()]));
 if(!await persistSpace(owner,{state:emptyState(),revision:0},state))throw new Error('seed');
 const ids=state.members.map(m=>m.id);
 await withScope(owner,async c=>{for(let i=0;i<ids.length;i+=100)await c.query('INSERT INTO gymos.gym_photos(owner_id,member_id,content) SELECT $1,x.id,$3 FROM jsonb_to_recordset($2::jsonb) AS x(id text)',[owner,JSON.stringify(ids.slice(i,i+100).map(id=>({id}))),jpeg(SIZE,'a')]);});
 await withScope(owner,c=>c.query("INSERT INTO gymos.gym_activity_archive(owner_id,event_id,branch,at,payload) SELECT $1,'ev-'||g,'main','2026-10-01T10:00:00.000Z',jsonb_build_object('id','ev-'||g,'at','2026-10-01T10:00:00.000Z','kind','seed','subject','s'||g,'actor','seed','branch','main') FROM generate_series(1,$2::int) g",[owner,EVENTS]));

 let m0=mem(),t0=Date.now();
 const current=await readEntitySpace(owner);
 const readMs=Date.now()-t0,dRead=mem()-m0;

 m0=mem();t0=Date.now();
 const arch=await archivedEvents(owner);
 const archMs=Date.now()-t0,dArch=mem()-m0;

 m0=mem();t0=Date.now();
 const merged={...current.state,events:[...new Map([...arch,...current.state.events].map(e=>[e.id,e])).values()],receipts:[]};
 const body=JSON.stringify({format:'gymos-backup',version:2,tenant:'t1',createdAt:new Date().toISOString(),revision:current.revision,digest:'x'.repeat(64),state:merged});
 const serMs=Date.now()-t0,dSer=mem()-m0;

 console.log(JSON.stringify({members:N,events:EVENTS,mergedEvents:merged.events.length,readMs,readDeltaMB:dRead,archiveMs:archMs,archiveDeltaMB:dArch,serializeMs:serMs,serializeDeltaMB:dSer,bodyMB:Math.round(body.length/1048576),peakMB:peak}));
 for(const tb of ['gym_recovery_photos','gym_entities','gym_photos','gym_recovery','member_code_access','gym_activity_archive'])await admin.query('DELETE FROM gymos.'+tb+' WHERE owner_id=$1',[owner]);
 await admin.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[owner]);
}catch(e){console.error('FAILED:',e);process.exitCode=1;}
finally{clearInterval(t);await admin.end();await getPool().end();}
