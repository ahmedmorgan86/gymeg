/**
 * Backup format v3: bounded, sectioned backup/restore over the gym_backup_sections staging
 * table (migration 20261122050000). Postgres backend only; Firestore keeps the v2 path.
 *
 * Bounds (the resource contract the reviewer holds this to):
 * - Every section is <= SECTION_MAX_BYTES (64 MiB) and digest-verified on assembly.
 * - Photo pages are BYTE-capped (PHOTO_PAGE_BYTES of serialized JSON), event pages are
 *   BYTE-capped (EVENT_PAGE_BYTES); page COUNTS are unbounded (photo quota ~40M -> ~20
 *   pages; the pre-existing unbounded archive -> as many pages as it needs), but no
 *   request, page, or in-memory buffer ever exceeds the caps.
 * - A session is capped at SESSION_MAX_SECTIONS sections and SESSION_MAX_BYTES total
 *   staged bytes; one active session per owner+actor+direction (starting a new one wipes
 *   the previous), rows expire after 30 minutes (same convention as gym_backup_transfers).
 * - downloadStart stages ONLY the core (derived without photo bodies at read); pages are
 *   staged one per downloadNext request, so no single request touches the whole archive.
 * - Restore validates the manifest (tenant/revision/digests/order/counts) and re-verifies
 *   every section digest BEFORE any destructive write; the apply runs inside the single
 *   persistSpace transaction (atomicity identical to v2) reading one page at a time.
 */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {getPool} from './database.ts';
import {assembleTransfer,backupDigest,BACKUP_CHUNK_BYTES,decodeChunk,TransferError} from './backup-transfer.ts';
import {readEntityCore,persistSpace,type StagedRestore} from './entity-store.ts';
import {RECENT_EVENTS} from './activity-archive.ts';
import {MEMBER_PHOTO_MAX} from './member-photo-input.ts';
import {useFirestorePersistence,getFirestoreDb} from './firestore-db.ts';
import {db} from './database.ts';
import type {Event,GymState} from './domain.ts';

export const SECTION_MAX_BYTES=64*1024*1024;
export const PHOTO_PAGE_BYTES=2_000_000;
export const EVENT_PAGE_BYTES=8_000_000;
export const SESSION_MAX_SECTIONS=4096;
export const SESSION_MAX_BYTES=256*1024*1024;

const utf8=(v:unknown)=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v)).byteLength;
const hex64=/^[a-f0-9]{64}$/;
const validUuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);

export function postgresOnlyV3(){if(useFirestorePersistence())throw new TransferError('unsupportedBackend',400);}

async function scoped<T>(owner:string,actor:string,run:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await getPool().connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.gym_owner',$1,true),set_config('app.gym_actor',$2,true)",[owner,actor]);const value=await run(c);await c.query('COMMIT');return value;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

/** One active session per owner+actor+direction: starting a session abandons and wipes the previous one plus anything expired. */
export async function createSession(owner:string,actor:string,direction:'upload'|'download'){
 return scoped(owner,actor,async c=>{
  await c.query('DELETE FROM gymos.gym_backup_sections WHERE owner_id=$1 AND actor_id=$2 AND (direction=$3 OR expires_at<now())',[owner,actor,direction]);
  return randomUUID();
 });
}

async function checkSessionBounds(c:PoolClient,sessionId:string,addBytes:number){
 const row=(await c.query('SELECT count(*)::int AS n,COALESCE(SUM(bytes),0)::bigint AS total FROM gymos.gym_backup_sections WHERE session_id=$1',[sessionId])).rows[0] as {n:number;total:string|number};
 if(row.n>=SESSION_MAX_SECTIONS||Number(row.total)+addBytes>SESSION_MAX_BYTES)throw new TransferError('limit');
}

const toChunks=(content:Buffer)=>{const chunks:Record<string,string>={};const parts=Math.ceil(content.length/BACKUP_CHUNK_BYTES);for(let i=0;i<parts;i++)chunks[String(i)]=content.subarray(i*BACKUP_CHUNK_BYTES,(i+1)*BACKUP_CHUNK_BYTES).toString('base64');return chunks;};

/** Download side: stage an already-assembled section buffer. */
export async function stageSection(owner:string,actor:string,sessionId:string,kind:'core'|'photos'|'events',ordinal:number,content:Buffer){
 if(!validUuid(sessionId)||!content.length||content.length>SECTION_MAX_BYTES)throw new TransferError('invalid');
 const digest=backupDigest(content);
 return scoped(owner,actor,async c=>{
  await checkSessionBounds(c,sessionId,content.length);
  const id=randomUUID();
  await c.query('INSERT INTO gymos.gym_backup_sections(id,session_id,owner_id,actor_id,direction,kind,ordinal,bytes,digest,chunks) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,sessionId,owner,actor,'download',kind,ordinal,content.length,digest,JSON.stringify(toChunks(content))]);
  return{id,bytes:content.length,digest,parts:Math.ceil(content.length/BACKUP_CHUNK_BYTES),chunkBytes:BACKUP_CHUNK_BYTES};
 });
}

/** Upload side: open an empty section the client will fill chunk by chunk. */
export async function openUploadSection(owner:string,actor:string,sessionId:string,kind:unknown,ordinal:unknown,bytes:unknown,digest:unknown){
 if(!validUuid(sessionId)||(kind!=='core'&&kind!=='photos'&&kind!=='events')||!Number.isSafeInteger(ordinal)||(ordinal as number)<0||!Number.isSafeInteger(bytes)||(bytes as number)<1||(bytes as number)>SECTION_MAX_BYTES||typeof digest!=='string'||!hex64.test(digest))throw new TransferError('invalid');
 return scoped(owner,actor,async c=>{
  await checkSessionBounds(c,sessionId,bytes as number);
  const id=randomUUID();
  await c.query('INSERT INTO gymos.gym_backup_sections(id,session_id,owner_id,actor_id,direction,kind,ordinal,bytes,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,sessionId,owner,actor,'upload',kind,ordinal,bytes,digest]);
  return{id,parts:Math.ceil((bytes as number)/BACKUP_CHUNK_BYTES),chunkBytes:BACKUP_CHUNK_BYTES};
 });
}

export async function putSectionChunk(owner:string,actor:string,sectionId:unknown,index:unknown,data:unknown){
 if(!validUuid(sectionId)||!Number.isSafeInteger(index)||(index as number)<0)throw new TransferError('invalid');
 const chunk=decodeChunk(data);
 return scoped(owner,actor,async c=>{
  const row=(await c.query("SELECT bytes,chunks -> $3::text AS previous FROM gymos.gym_backup_sections WHERE id=$1 AND owner_id=$2 AND actor_id=$3 AND direction='upload' AND expires_at>now() FOR UPDATE",[sectionId,owner,actor])).rows[0] as {bytes:number;previous:string|null}|undefined;
  if(!row)throw new TransferError('notFound',404);
  const parts=Math.ceil(row.bytes/BACKUP_CHUNK_BYTES);
  if((index as number)>=parts||chunk.length!==Math.min(BACKUP_CHUNK_BYTES,row.bytes-(index as number)*BACKUP_CHUNK_BYTES))throw new TransferError('invalidChunk');
  if(row.previous&&row.previous!==data)throw new TransferError('chunkMismatch',409);
  await c.query('UPDATE gymos.gym_backup_sections SET chunks=jsonb_set(chunks,ARRAY[$4::text],to_jsonb($5::text)) WHERE id=$1 AND owner_id=$2 AND actor_id=$3',[sectionId,owner,actor,String(index),data]);
  return{ok:true};
 });
}

export async function getSectionChunk(owner:string,actor:string,sectionId:unknown,index:unknown){
 if(!validUuid(sectionId)||!Number.isSafeInteger(index)||(index as number)<0)throw new TransferError('invalid');
 return scoped(owner,actor,async c=>{
  const row=(await c.query("SELECT chunks ->> $4::text AS data FROM gymos.gym_backup_sections WHERE id=$1 AND owner_id=$2 AND actor_id=$3 AND direction='download' AND expires_at>now()",[sectionId,owner,actor,String(index)])).rows[0] as {data:string}|undefined;
  if(!row?.data)throw new TransferError('notFound',404);
  return{data:row.data};
 });
}

/** Assemble a staged section and verify size+digest. Memory: one section (<=64 MiB cap; pages are far smaller). */
async function sectionContent(owner:string,actor:string,sectionId:string,direction:'upload'|'download'):Promise<Buffer>{
 return scoped(owner,actor,async c=>{
  const row=(await c.query('SELECT bytes,digest,chunks FROM gymos.gym_backup_sections WHERE id=$1 AND owner_id=$2 AND actor_id=$3 AND direction=$4 AND expires_at>now()',[sectionId,owner,actor,direction])).rows[0] as {bytes:number;digest:string;chunks:Record<string,string>}|undefined;
  if(!row)throw new TransferError('notFound',404);
  return assembleTransfer(row);
 });
}

export async function discardSession(owner:string,actor:string,sessionId:unknown){
 if(!validUuid(sessionId))throw new TransferError('invalid');
 await scoped(owner,actor,async c=>{await c.query('DELETE FROM gymos.gym_backup_sections WHERE owner_id=$1 AND actor_id=$2 AND session_id=$3',[owner,actor,sessionId]);});
}

// ---------- Download section builders ----------

/** Core state JSON for v3: photos excluded at read, events trimmed to recent, receipts cleared. Recovery snapshots are stripped the same way at parse (never rehydrated into the live store). */
export async function buildCoreBuffer(owner:string,recovery?:string):Promise<{buffer:Buffer;revision:number}>{
 let state:GymState,revision:number;
 if(recovery){
  const row=useFirestorePersistence()?(await getFirestoreDb().collection('gym_recovery').doc(recovery).get()).data():await db.prepare('SELECT payload FROM gym_recovery WHERE owner_id=? AND id=?').bind(owner,recovery).first<{payload:string}>(owner);
  if(!row||useFirestorePersistence()&&(row as {owner_id?:string}).owner_id!==owner)throw new TransferError('notFound',404);
  const parsed=JSON.parse((row as {payload:string}).payload) as GymState;
  const current=await readEntityCore(owner);revision=current.revision;state=parsed;
 }else{
  const current=await readEntityCore(owner);state=current.state;revision=current.revision;
 }
 state={...state,members:state.members.map(m=>{if(m.photo===undefined)return m;const rest={...m};delete rest.photo;return rest;}),events:state.events.slice(-RECENT_EVENTS),receipts:[]};
 return{buffer:Buffer.from(JSON.stringify(state),'utf8'),revision};
}

/** Next byte-capped photo page after cursor (keyset on member_id). */
export async function nextPhotoPage(owner:string,cursor:string|null):Promise<{page:Record<string,string>;nextCursor:string|null;done:boolean}>{
 return scoped(owner,'system',async c=>{
  const page:Record<string,string>={};let bytes=2,last:string|null=cursor;
  for(;;){
   const rows=(await c.query('SELECT member_id,content FROM gymos.gym_photos WHERE owner_id=$1 AND ($2::text IS NULL OR member_id>$2) ORDER BY member_id LIMIT 200',[owner,last])).rows as {member_id:string;content:string}[];
   if(!rows.length)return{page,nextCursor:last,done:true};
   for(const r of rows){
    const cost=utf8(r.member_id)+utf8(r.content)+9;
    if(bytes+cost>PHOTO_PAGE_BYTES&&last!==cursor)return{page,nextCursor:last,done:false};
    page[r.member_id]=r.content;bytes+=cost;last=r.member_id;
   }
  }
 });
}

/** Next byte-capped archive event page after cursor (keyset on (at,event_id)). */
export async function nextEventPage(owner:string,cursor:{at:string;id:string}|null):Promise<{page:Event[];nextCursor:{at:string;id:string}|null;done:boolean}>{
 return scoped(owner,'system',async c=>{
  const page:Event[]=[];let bytes=2,last=cursor;
  for(;;){
   const rows=(await c.query('SELECT payload FROM gymos.gym_activity_archive WHERE owner_id=$1 AND ($2::text IS NULL OR (at,event_id)>($2,$3)) ORDER BY at,event_id LIMIT 500',[owner,last?.at??null,last?.id??null])).rows as {payload:Event}[];
   if(!rows.length)return{page,nextCursor:last,done:true};
   for(const r of rows){
    const cost=utf8(r.payload)+2;
    if(bytes+cost>EVENT_PAGE_BYTES&&page.length)return{page,nextCursor:last,done:false};
    page.push(r.payload);bytes+=cost;last={at:r.payload.at,id:r.payload.id};
   }
  }
 });
}

export async function photoCount(owner:string):Promise<number>{return scoped(owner,'system',async c=>Number((await c.query('SELECT count(*)::int AS n FROM gymos.gym_photos WHERE owner_id=$1',[owner])).rows[0]?.n??0));}
export async function archiveCount(owner:string):Promise<number>{return scoped(owner,'system',async c=>Number((await c.query('SELECT count(*)::int AS n FROM gymos.gym_activity_archive WHERE owner_id=$1',[owner])).rows[0]?.n??0));}

// ---------- Manifest + restore ----------

export type SectionRef={ordinal:number;bytes:number;digest:string;transfer:string};
export type BackupV3Manifest={format:'gymos-backup';version:3;tenant:string;createdAt:string;revision:number;core:{bytes:number;digest:string};photos:{count:number;pages:SectionRef[]};events:{count:number;pages:SectionRef[]};digest:string};

const validSectionRef=(s:unknown):s is SectionRef=>!!s&&typeof s==='object'&&Number.isSafeInteger((s as SectionRef).ordinal)&&(s as SectionRef).ordinal>=0&&Number.isSafeInteger((s as SectionRef).bytes)&&(s as SectionRef).bytes>=1&&(s as SectionRef).bytes<=SECTION_MAX_BYTES&&typeof (s as SectionRef).digest==='string'&&hex64.test((s as SectionRef).digest)&&validUuid((s as SectionRef).transfer);

/** Structural validation + digest binding of the whole manifest, before anything is read or written. */
export function validateManifest(value:unknown):BackupV3Manifest{
 const m=value as BackupV3Manifest;
 if(!m||m.format!=='gymos-backup'||m.version!==3||typeof m.tenant!=='string'||!m.tenant||typeof m.createdAt!=='string'||!Number.isSafeInteger(m.revision)||m.revision<0)throw new TransferError('invalidBackup',400);
 if(!m.core||!Number.isSafeInteger(m.core.bytes)||m.core.bytes<1||m.core.bytes>SECTION_MAX_BYTES||typeof m.core.digest!=='string'||!hex64.test(m.core.digest))throw new TransferError('invalidBackup',400);
 for(const sec of [m.photos,m.events]){
  if(!sec||!Number.isSafeInteger(sec.count)||sec.count<0||!Array.isArray(sec.pages))throw new TransferError('invalidBackup',400);
  sec.pages.forEach((p,i)=>{if(!validSectionRef(p)||p.ordinal!==i)throw new TransferError('invalidBackup',400);}); // order explicit + contiguous: no omissions, no reorder
  if(new Set(sec.pages.map(p=>p.transfer)).size!==sec.pages.length)throw new TransferError('invalidBackup',400); // no duplicate sections
 }
 if(typeof m.digest!=='string'||!hex64.test(m.digest))throw new TransferError('invalidBackup',400);
 const {digest:_,...rest}=m;
 if(backupDigest(Buffer.from(JSON.stringify(rest),'utf8'))!==m.digest)throw new TransferError('digestMismatch');
 return m;
}

const PHOTO_RE=/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/=]+$/;
const validPhotoEntry=(id:unknown,content:unknown):id is string=>typeof id==='string'&&id.length>=1&&id.length<=250&&typeof content==='string'&&content.length<=MEMBER_PHOTO_MAX&&PHOTO_RE.test(content);
const validEvent=(e:unknown):e is Event=>!!e&&typeof e==='object'&&typeof (e as Event).id==='string'&&(e as Event).id.length>=1&&(e as Event).id.length<=250&&typeof (e as Event).at==='string'&&Number.isFinite(Date.parse((e as Event).at))&&typeof (e as Event).kind==='string'&&(e as Event).kind.length<=100&&typeof (e as Event).subject==='string'&&(e as Event).subject.length<=250&&typeof (e as Event).actor==='string'&&(e as Event).actor.length<=500&&typeof (e as Event).branch==='string'&&(e as Event).branch.length<=250&&((e as Event).detail===undefined||typeof (e as Event).detail==='string'&&(e as Event).detail!.length<=500);

export async function readValidatedCore(owner:string,actor:string,sessionId:string,manifest:BackupV3Manifest):Promise<GymState>{
 const row=(await sectionRows(owner,actor,sessionId)).find(r=>r.kind==='core'&&r.ordinal===0);
 if(!row||row.bytes!==manifest.core.bytes||row.digest!==manifest.core.digest)throw new TransferError('invalidBackup',400);
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await sectionContent(owner,actor,row.id,'upload'))) as GymState;
}

type SectionRow={id:string;kind:string;ordinal:number;bytes:number;digest:string};
async function sectionRows(owner:string,actor:string,sessionId:string):Promise<SectionRow[]>{
 return scoped(owner,actor,async c=>(await c.query("SELECT id,kind,ordinal,bytes,digest FROM gymos.gym_backup_sections WHERE owner_id=$1 AND actor_id=$2 AND session_id=$3 AND direction='upload' AND expires_at>now() ORDER BY kind,ordinal",[owner,actor,sessionId])).rows as SectionRow[]);
}

/**
 * Complete pre-validation (every section exists, digest-matches the manifest, parses, entry
 * shapes valid, counts match) BEFORE persistSpace performs any destructive write. The apply
 * itself re-reads the same digest-pinned sections inside the restore transaction, one page
 * at a time; any failure rolls the whole restore back.
 */
export async function commitRestoreV3(owner:string,actor:string,sessionId:string,manifest:BackupV3Manifest,current:{state:GymState;revision:number},state:GymState):Promise<boolean>{
 if(!validUuid(sessionId))throw new TransferError('invalid');
 const rows=await sectionRows(owner,actor,sessionId);
 const pick=(kind:string,ordinal:number)=>rows.find(r=>r.kind===kind&&r.ordinal===ordinal);
 const expected=1+manifest.photos.pages.length+manifest.events.pages.length;
 if(rows.length!==expected)throw new TransferError('invalidBackup',400); // nothing staged beyond the manifest
 const photoRows=manifest.photos.pages.map(p=>{const r=pick('photos',p.ordinal);if(!r||r.bytes!==p.bytes||r.digest!==p.digest)throw new TransferError('invalidBackup',400);return r;});
 const eventRows=manifest.events.pages.map(p=>{const r=pick('events',p.ordinal);if(!r||r.bytes!==p.bytes||r.digest!==p.digest)throw new TransferError('invalidBackup',400);return r;});
 // Pre-validation pass (no writes): parse + entry shapes + counts.
 let photoTotal=0;
 for(const r of photoRows){
  const page=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await sectionContent(owner,actor,r.id,'upload'))) as Record<string,string>;
  if(!page||typeof page!=='object'||Array.isArray(page))throw new TransferError('invalidBackup',400);
  for(const [id,content]of Object.entries(page))if(!validPhotoEntry(id,content))throw new TransferError('invalidBackup',400);
  photoTotal+=Object.keys(page).length;
 }
 if(photoTotal!==manifest.photos.count)throw new TransferError('invalidBackup',400);
 let eventTotal=0;
 for(const r of eventRows){
  const page=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await sectionContent(owner,actor,r.id,'upload'))) as Event[];
  if(!Array.isArray(page)||!page.every(validEvent))throw new TransferError('invalidBackup',400);
  eventTotal+=page.length;
 }
 if(eventTotal!==manifest.events.count)throw new TransferError('invalidBackup',400);
 // Apply: one transaction inside persistSpace; pages re-read and digest-verified again.
 const staged:StagedRestore={
  photos:(async function*(){for(const r of photoRows)yield JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await sectionContent(owner,actor,r.id,'upload'))) as Record<string,string>;})(),
  archiveEvents:(async function*(){for(const r of eventRows)yield JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await sectionContent(owner,actor,r.id,'upload'))) as Event[];})(),
 };
 return persistSpace(owner,current,state,true,undefined,staged);
}
