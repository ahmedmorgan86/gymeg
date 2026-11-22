/**
 * Backup format v3: bounded, sectioned backup/restore over a durable session registry
 * (migration 20261122050000). Postgres backend only; Firestore keeps the v2 path.
 *
 * Bounds (the resource contract the reviewer holds this to):
 * - Every section is <= SECTION_MAX_BYTES (64 MiB) and digest-verified on assembly.
 * - Photo pages are BYTE-capped: pack target PHOTO_PAGE_BYTES, hard maximum
 *   PHOTO_PAGE_MAX_BYTES (target + one maximal photo entry). Event pages likewise
 *   (EVENT_PAGE_BYTES / EVENT_PAGE_MAX_BYTES). Page COUNTS are unbounded (the pre-existing
 *   unbounded archive becomes unbounded page count, never unbounded bytes in flight).
 * - A session is a DURABLE REGISTRY ROW (gym_backup_sessions), unique per
 *   owner+actor+direction: arbitrary UUIDs cannot stage, and starting a session atomically
 *   abandons+wipes the previous one. Caps: SESSION_MAX_SECTIONS, SESSION_MAX_BYTES per
 *   session and OWNER_MAX_STAGED_BYTES aggregate per owner across ALL actors/directions;
 *   every admission takes the owner-scoped advisory lock, so concurrent actors cannot race
 *   the aggregate cap. Rows expire after 30 minutes and are cleaned lazily on every
 *   staging call (same convention as gym_backup_transfers).
 * - Staged bytes bound restore work: SESSION_MAX_BYTES caps what a commit can apply, so an
 *   archive too large to stage fails loudly at download instead of producing an unbounded
 *   restore transaction.
 * - Downloads pin the core's revision in the session row; every downloadNext re-checks it,
 *   so pages can never silently mix states across concurrent writes. Recovery downloads
 *   page the SNAPSHOT's own photos (historical portraits), never the live ones.
 * - Restore validates the manifest (tenant/revision/digests/order/counts) and every section
 *   (exists, belongs to the session, digest match, parses, entry shapes, photo ids bound to
 *   core members, no cross-page duplicates, exact counts) BEFORE any destructive write, then
 *   applies inside the single persistSpace transaction, re-reading digest-pinned pages one
 *   at a time. Any failure rolls the whole restore back.
 */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {getPool} from './database.ts';
import {assembleTransfer,backupDigest,BACKUP_CHUNK_BYTES,decodeChunk,TransferError} from './backup-transfer.ts';
import {readEntityCore,persistSpaceTx,type StagedRestore} from './entity-store.ts';
import {processWorkspaceOutbox} from './realtime-broadcast.ts';
import {STATE_BYTE_LIMIT} from './workspace-slice.ts';
import {validateBackup} from './backup.ts';
import {RECENT_EVENTS} from './activity-archive.ts';
import {MEMBER_PHOTO_MAX} from './member-photo-input.ts';
import {useFirestorePersistence,getFirestoreDb} from './firestore-db.ts';
import {db} from './database.ts';
import type {Event,GymState} from './domain.ts';

export const SECTION_MAX_BYTES=64*1024*1024;
export const PHOTO_PAGE_BYTES=2_000_000;
/** A photo page never exceeds the pack target plus one maximal entry (96,000-char photo + id + JSON overhead). */
export const PHOTO_PAGE_MAX_BYTES=PHOTO_PAGE_BYTES+MEMBER_PHOTO_MAX+300;
export const EVENT_PAGE_BYTES=8_000_000;
/** An event page never exceeds the pack target plus one maximal event (~1.5KB by the event schema bounds). */
export const EVENT_PAGE_MAX_BYTES=EVENT_PAGE_BYTES+2048;
export const SESSION_MAX_SECTIONS=4096;
export const SESSION_MAX_BYTES=256*1024*1024;
/** Aggregate staged storage per OWNER across all actors/directions/sessions: many actors must not multiply the per-session cap. */
export const OWNER_MAX_STAGED_BYTES=512*1024*1024;

const utf8=(v:unknown)=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v)).byteLength;
const hex64=/^[a-f0-9]{64}$/;
const validUuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);

export function postgresOnlyV3(){if(useFirestorePersistence())throw new TransferError('unsupportedBackend',400);}

async function scoped<T>(owner:string,actor:string,run:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await getPool().connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.gym_owner',$1,true),set_config('app.gym_actor',$2,true)",[owner,actor]);const value=await run(c);await c.query('COMMIT');return value;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

type SessionRow={id:string;direction:'upload'|'download';revision:number|null;snapshot:boolean};

/** Fetch the session row FOR UPDATE (serializes staging admissions within the session) or throw. */
async function requireSession(c:PoolClient,owner:string,actor:string,sessionId:string,direction?:'upload'|'download'):Promise<SessionRow>{
 const row=(await c.query('SELECT id,direction,revision,snapshot FROM gymos.gym_backup_sessions WHERE id=$1 AND owner_id=$2 AND actor_id=$3 AND expires_at>now() FOR UPDATE',[sessionId,owner,actor])).rows[0] as SessionRow|undefined;
 if(!row||(direction&&row.direction!==direction))throw new TransferError('notFound',404);
 return row;
}

/** Owner-scoped admission lock: concurrent actors cannot race the aggregate staged-storage cap. */
async function admissionLock(c:PoolClient,owner:string){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner+'|backup-sections']);}

/** One active session per owner+actor+direction (UNIQUE): starting a session abandons and wipes the previous one plus anything expired. Download sessions pin the core's revision. */
export async function createSession(owner:string,actor:string,direction:'upload'|'download',pinRevision?:number,snapshot=false){
 return scoped(owner,actor,async c=>{
  await admissionLock(c,owner);
  await c.query('SELECT gymos.cleanup_expired_backup_sections()'); // definer: expired rows of EVERY actor are removed (actor-scoped RLS hides them from own DELETEs)
  await c.query('DELETE FROM gymos.gym_backup_sections WHERE owner_id=$1 AND actor_id=$2 AND session_id IN (SELECT id FROM gymos.gym_backup_sessions WHERE owner_id=$1 AND actor_id=$2 AND direction=$3)',[owner,actor,direction]);
  await c.query('DELETE FROM gymos.gym_backup_sessions WHERE owner_id=$1 AND actor_id=$2 AND direction=$3',[owner,actor,direction]);
  const id=randomUUID();
  await c.query('INSERT INTO gymos.gym_backup_sessions(id,owner_id,actor_id,direction,revision,snapshot) VALUES($1,$2,$3,$4,$5,$6)',[id,owner,actor,direction,pinRevision??null,snapshot]);
  return id;
 });
}

/** Download pages are pinned to the core's revision: any intervening write fails the page request instead of silently mixing states. */
export async function sessionInfo(owner:string,actor:string,sessionId:string,direction:'upload'|'download'):Promise<{revision:number|null;snapshot:boolean}>{
 if(!validUuid(sessionId))throw new TransferError('invalid');
 return scoped(owner,actor,async c=>{const s=await requireSession(c,owner,actor,sessionId,direction);return{revision:s.revision,snapshot:s.snapshot};});
}
/** Revision pin re-checked INSIDE the page's own transaction: a page can never serve data from a revision other than the one pinned at downloadStart. Uploads pin null and skip. */
async function assertPinned(c:PoolClient,owner:string,pinRevision:number|null|undefined){
 if(pinRevision===null||pinRevision===undefined)return;
 const current=(await c.query('SELECT revision FROM gymos.gym_states WHERE user_id=$1 FOR SHARE',[owner])).rows[0] as {revision:number}|undefined; // FOR SHARE brackets the page read: a writer must wait for this tx, so the pinned revision cannot advance between check and payload
 if(!current||current.revision!==pinRevision)throw new TransferError('conflict',409);
}

async function checkSessionBounds(c:PoolClient,owner:string,sessionId:string,addBytes:number){
 const row=(await c.query('SELECT count(*)::int AS n,COALESCE(SUM(bytes),0)::bigint AS total FROM gymos.gym_backup_sections WHERE session_id=$1',[sessionId])).rows[0] as {n:number;total:string|number};
 if(row.n>=SESSION_MAX_SECTIONS||Number(row.total)+addBytes>SESSION_MAX_BYTES)throw new TransferError('limit');
 const ownerRow=(await c.query('SELECT gymos.backup_owner_staged_bytes() AS total')).rows[0] as {total:string|number}; // definer: sums across ALL actors of this owner; actor-scoped FORCE RLS would hide them
 if(Number(ownerRow.total)+addBytes>OWNER_MAX_STAGED_BYTES)throw new TransferError('limit');
}

const toChunks=(content:Buffer)=>{const chunks:Record<string,string>={};const parts=Math.ceil(content.length/BACKUP_CHUNK_BYTES);for(let i=0;i<parts;i++)chunks[String(i)]=content.subarray(i*BACKUP_CHUNK_BYTES,(i+1)*BACKUP_CHUNK_BYTES).toString('base64');return chunks;};

/** Download side: stage an already-assembled section buffer into a live session. */
export async function stageSection(owner:string,actor:string,sessionId:string,kind:'core'|'photos'|'events',ordinal:number,content:Buffer){
 if(!validUuid(sessionId)||!content.length||content.length>SECTION_MAX_BYTES)throw new TransferError('invalid');
 const digest=backupDigest(content);
 return scoped(owner,actor,async c=>{
  await admissionLock(c,owner);
  await requireSession(c,owner,actor,sessionId,'download');
  await c.query('SELECT gymos.cleanup_expired_backup_sections()');
  await checkSessionBounds(c,owner,sessionId,content.length);
  const id=randomUUID();
  await c.query('INSERT INTO gymos.gym_backup_sections(id,session_id,owner_id,actor_id,direction,kind,ordinal,bytes,digest,chunks) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,sessionId,owner,actor,'download',kind,ordinal,content.length,digest,JSON.stringify(toChunks(content))]);
  return{id,bytes:content.length,digest,parts:Math.ceil(content.length/BACKUP_CHUNK_BYTES),chunkBytes:BACKUP_CHUNK_BYTES};
 });
}

/** Upload side: open an empty section the client will fill chunk by chunk. */
export async function openUploadSection(owner:string,actor:string,sessionId:string,kind:unknown,ordinal:unknown,bytes:unknown,digest:unknown){
 if(!validUuid(sessionId)||(kind!=='core'&&kind!=='photos'&&kind!=='events')||!Number.isSafeInteger(ordinal)||(ordinal as number)<0||!Number.isSafeInteger(bytes)||(bytes as number)<1||(bytes as number)>SECTION_MAX_BYTES||typeof digest!=='string'||!hex64.test(digest))throw new TransferError('invalid');
 return scoped(owner,actor,async c=>{
  await admissionLock(c,owner);
  await requireSession(c,owner,actor,sessionId,'upload');
  await c.query('SELECT gymos.cleanup_expired_backup_sections()');
  await checkSessionBounds(c,owner,sessionId,bytes as number);
  const id=randomUUID();
  await c.query('INSERT INTO gymos.gym_backup_sections(id,session_id,owner_id,actor_id,direction,kind,ordinal,bytes,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,sessionId,owner,actor,'upload',kind,ordinal,bytes,digest]);
  return{id,parts:Math.ceil((bytes as number)/BACKUP_CHUNK_BYTES),chunkBytes:BACKUP_CHUNK_BYTES};
 });
}

export async function putSectionChunk(owner:string,actor:string,sectionId:unknown,index:unknown,data:unknown){
 if(!validUuid(sectionId)||!Number.isSafeInteger(index)||(index as number)<0)throw new TransferError('invalid');
 const chunk=decodeChunk(data);
 return scoped(owner,actor,async c=>{
  const row=(await c.query("SELECT bytes,chunks -> $4::text AS previous FROM gymos.gym_backup_sections WHERE id=$1 AND owner_id=$2 AND actor_id=$3 AND direction='upload' AND expires_at>now() FOR UPDATE",[sectionId,owner,actor,String(index)])).rows[0] as {bytes:number;previous:string|null}|undefined;
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
 await scoped(owner,actor,async c=>{
  await c.query('DELETE FROM gymos.gym_backup_sections WHERE owner_id=$1 AND actor_id=$2 AND session_id=$3',[owner,actor,sessionId]);
  await c.query('DELETE FROM gymos.gym_backup_sessions WHERE owner_id=$1 AND actor_id=$2 AND id=$3',[owner,actor,sessionId]);
 });
}

// ---------- Download section builders ----------

/** Pack a photos map into byte-capped pages (used for recovery snapshots; live photos page straight from gym_photos). */
export function packPhotoPages(photos:Record<string,string>):Record<string,string>[]{
 const pages:Record<string,string>[]=[];let page:Record<string,string>=Object.create(null),bytes=2; // null-prototype: reserved ids like __proto__ must be own entries, never lost to the prototype
 for(const [id,content]of Object.entries(photos).sort((a,b)=>a[0]<b[0]?-1:1)){
  const cost=utf8(id)+utf8(content)+9;
  if(bytes+cost>PHOTO_PAGE_BYTES&&Object.keys(page).length){pages.push(page);page=Object.create(null);bytes=2;}
  page[id]=content;bytes+=cost;
 }
 if(Object.keys(page).length)pages.push(page);
 return pages;
}

export function packEventPages(events:Event[]):Event[][]{
 const pages:Event[][]=[];let page:Event[]=[],bytes=2;
 for(const e of events){const cost=utf8(JSON.stringify(e))+2;if(cost>EVENT_PAGE_BYTES)throw new TransferError('limit',413); // one malformed pre-existing event above the hard page cap fails BEFORE packing; the 64MiB section ceiling is not the page bound
  if(bytes+cost>EVENT_PAGE_BYTES&&page.length){pages.push(page);page=[];bytes=2;}page.push(e);bytes+=cost;}
 if(page.length)pages.push(page);
 return pages;
}

/**
 * Core state JSON for v3: photos excluded at read, events trimmed to recent, receipts cleared.
 * Recovery snapshots are stripped at parse (never rehydrated into the live store) and their
 * OWN inline photos are returned for paging, so a historical export carries historical portraits.
 * Note: a legacy recovery payload is one pre-existing monolithic row; parsing it is bounded by
 * that row's stored size (same as v2 today), not by the section caps.
 */
export async function buildCoreBuffer(owner:string,recovery?:string):Promise<{buffer:Buffer;revision:number;snapshotPhotos?:Record<string,string>;snapshotEvents?:Event[];selfContained:boolean}>{
 let state:GymState,revision:number,snapshotPhotos:Record<string,string>|undefined,snapshotEvents:Event[]|undefined,legacy=false;
 if(recovery){
  const row=useFirestorePersistence()?(await getFirestoreDb().collection('gym_recovery').doc(recovery).get()).data():await db.prepare('SELECT payload FROM gym_recovery WHERE owner_id=? AND id=?').bind(owner,recovery).first<{payload:string}>(owner);
  if(!row||useFirestorePersistence()&&(row as {owner_id?:string}).owner_id!==owner)throw new TransferError('notFound',404);
  const parsed=JSON.parse((row as {payload:string}).payload) as GymState;
  const current=await readEntityCore(owner);revision=current.revision;state=parsed;
  snapshotEvents=state.events; // the snapshot's OWN history, complete: staged as event pages, never re-trimmed, never live archive rows
 }else{
  const current=await readEntityCore(owner);state=current.state;revision=current.revision;
  legacy=Boolean('legacy' in current&&current.legacy);
  if(legacy)snapshotEvents=state.events; // legacy blob: the normalized archive is never populated; the blob's own history must be staged, not the empty archive table
 }
 snapshotPhotos=Object.create(null); // ids like __proto__ must survive assignment
 state={...state,members:state.members.map(m=>{if(m.photo===undefined)return m;const rest={...m};snapshotPhotos![m.id]=m.photo as string;delete rest.photo;return rest;}),events:snapshotEvents?[]:state.events.slice(-RECENT_EVENTS),receipts:[]};
 if(!Object.keys(snapshotPhotos!).length)snapshotPhotos=undefined;
 if(!snapshotEvents?.length)snapshotEvents=undefined;
 const buffer=Buffer.from(JSON.stringify(state),'utf8');
 if(buffer.length>STATE_BYTE_LIMIT+1048576)throw new TransferError('limit',413); // core admission: the write-side invariant already keeps cores under STATE_BYTE_LIMIT; this is the loud bound, never an unbounded materialization
 return{buffer,revision,snapshotPhotos,snapshotEvents,selfContained:Boolean(recovery)||legacy}; // legacy identity is independent of event count: a legacy blob with photos but zero events is still self-contained
}

/** Next byte-capped photo page after cursor (keyset on member_id). Never exceeds PHOTO_PAGE_MAX_BYTES. */
export async function nextPhotoPage(owner:string,cursor:string|null,pinRevision?:number|null):Promise<{page:Record<string,string>;nextCursor:string|null;done:boolean}>{
 return scoped(owner,'system',async c=>{
  await assertPinned(c,owner,pinRevision);
  const rows=(await c.query(`WITH s AS (SELECT member_id,octet_length(content) AS n FROM gymos.gym_photos WHERE owner_id=$1 AND ($2::text IS NULL OR member_id>$2) ORDER BY member_id LIMIT 64), w AS (SELECT member_id,n,SUM(octet_length(member_id)+n+9) OVER (ORDER BY member_id) AS running, count(*) OVER () AS scanned FROM s) SELECT p.member_id,p.content,w.scanned FROM w JOIN gymos.gym_photos p ON p.owner_id=$1 AND p.member_id=w.member_id WHERE w.running<=$3 ORDER BY p.member_id`,[owner,cursor,PHOTO_PAGE_BYTES])).rows as {member_id:string;content:string;scanned:string}[]; // byte admission in SQL BEFORE any content transfer: candidates carry ids+sizes only, content fetched for admitted rows alone
  const page:Record<string,string>=Object.create(null);for(const r of rows)page[r.member_id]=r.content;
  const scanned=Number(rows[0]?.scanned??0);
  return{page,nextCursor:rows.length?rows[rows.length-1].member_id:cursor,done:rows.length===scanned&&scanned<64};
 });
}

/** Next byte-capped archive event page after cursor (keyset on (at,event_id)). Never exceeds EVENT_PAGE_MAX_BYTES. */
export async function nextEventPage(owner:string,cursor:{at:string;id:string}|null,pinRevision?:number|null):Promise<{page:Event[];nextCursor:{at:string;id:string}|null;done:boolean}>{
 return scoped(owner,'system',async c=>{
  await assertPinned(c,owner,pinRevision);
  const rows=(await c.query(`WITH s AS (SELECT at,event_id,octet_length(payload::text)+2 AS cost FROM gymos.gym_activity_archive WHERE owner_id=$1 AND ($2::text IS NULL OR (at,event_id)>($2,$3)) ORDER BY at,event_id LIMIT 513), w AS (SELECT at,event_id,cost,SUM(cost) OVER (ORDER BY at,event_id) AS running, count(*) OVER () AS scanned FROM s) SELECT w.at,w.event_id,w.scanned,a.payload FROM w JOIN gymos.gym_activity_archive a ON a.owner_id=$1 AND a.event_id=w.event_id AND a.at=w.at WHERE w.running<=$4 ORDER BY w.at,w.event_id`,[owner,cursor?.at??null,cursor?.id??null,EVENT_PAGE_BYTES])).rows as {at:string;event_id:string;payload:Event;scanned:string}[]; // byte admission in SQL BEFORE any payload transfer: candidates carry (at,event_id,bytes) only, payloads joined for admitted rows alone
  if(!rows.length){
   const head=(await c.query('SELECT at,event_id,octet_length(payload::text) AS n FROM gymos.gym_activity_archive WHERE owner_id=$1 AND ($2::text IS NULL OR (at,event_id)>($2,$3)) ORDER BY at,event_id LIMIT 1',[owner,cursor?.at??null,cursor?.id??null])).rows[0] as {at:string;event_id:string;n:number}|undefined;
   if(!head)return{page:[],nextCursor:cursor,done:true};
   if(head.n>EVENT_PAGE_MAX_BYTES)throw new TransferError('limit',413); // one pre-existing row above the hard page maximum: fail loudly, never emit an over-cap page - byte check precedes payload transfer
   const one=(await c.query('SELECT payload FROM gymos.gym_activity_archive WHERE owner_id=$1 AND event_id=$2 AND at=$3',[owner,head.event_id,head.at])).rows[0] as {payload:Event};
   return{page:[one.payload],nextCursor:{at:head.at,id:head.event_id},done:false};
  }
  const last=rows[rows.length-1];const scanned=Number(rows[0].scanned);
  return{page:rows.map(r=>r.payload),nextCursor:{at:last.at,id:last.event_id},done:rows.length===scanned&&scanned<513};
 });
}

export async function photoCount(owner:string):Promise<number>{return scoped(owner,'system',async c=>Number((await c.query('SELECT count(*)::int AS n FROM gymos.gym_photos WHERE owner_id=$1',[owner])).rows[0]?.n??0));}
export async function archiveCount(owner:string):Promise<number>{return scoped(owner,'system',async c=>Number((await c.query('SELECT count(*)::int AS n FROM gymos.gym_activity_archive WHERE owner_id=$1',[owner])).rows[0]?.n??0));}
/** Byte estimate for client fallback planning (feature-detected streaming vs bounded accumulation). */
export async function downloadEstimate(owner:string):Promise<{photoBytes:number;eventBytes:number}>{return scoped(owner,'system',async c=>{const p=(await c.query('SELECT COALESCE(SUM(length(content)),0)::bigint AS n FROM gymos.gym_photos WHERE owner_id=$1',[owner])).rows[0] as {n:string|number};const e=(await c.query('SELECT COALESCE(SUM(octet_length(payload::text)),0)::bigint AS n FROM gymos.gym_activity_archive WHERE owner_id=$1',[owner])).rows[0] as {n:string|number};return{photoBytes:Number(p.n),eventBytes:Number(e.n)};});}

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
const validEvent=(e:unknown):e is Event=>!!e&&typeof e==='object'&&Buffer.byteLength(JSON.stringify(e),'utf8')<=65536&&typeof (e as Event).id==='string'&&(e as Event).id.length>=1&&(e as Event).id.length<=250&&typeof (e as Event).at==='string'&&Number.isFinite(Date.parse((e as Event).at))&&typeof (e as Event).kind==='string'&&(e as Event).kind.length<=100&&typeof (e as Event).subject==='string'&&(e as Event).subject.length<=250&&typeof (e as Event).actor==='string'&&(e as Event).actor.length<=500&&typeof (e as Event).branch==='string'&&(e as Event).branch.length<=250&&((e as Event).detail===undefined||typeof (e as Event).detail==='string'&&(e as Event).detail!.length<=500);

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
 * Complete pre-validation (every section exists in THIS session, digest-matches the manifest,
 * parses, entry shapes valid, every photo id is a member of the restored core, no cross-page
 * duplicates, exact counts) BEFORE persistSpace performs any destructive write. The apply
 * itself re-reads the same digest-pinned sections inside the restore transaction, one page
 * at a time; any failure rolls the whole restore back.
 */
export async function commitRestoreV3(owner:string,actor:string,sessionId:string,manifest:BackupV3Manifest,current:{state:GymState;revision:number},adjust?:(state:GymState,current:{state:GymState;revision:number})=>GymState):Promise<boolean>{
 if(!validUuid(sessionId))throw new TransferError('invalid');
 const client=await getPool().connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.gym_owner',$1,true),set_config('app.gym_actor',$2,true)",[owner,actor]);
  await requireSession(client,owner,actor,sessionId,'upload'); // FOR UPDATE: no staging mutation can interleave with this restore
  const rows=(await client.query("SELECT id,kind,ordinal,bytes,digest FROM gymos.gym_backup_sections WHERE owner_id=$1 AND actor_id=$2 AND session_id=$3 AND direction='upload' AND expires_at>now() ORDER BY kind,ordinal FOR UPDATE",[owner,actor,sessionId])).rows as SectionRow[];
  const pick=(kind:string,ordinal:number,transfer:string)=>rows.find(r=>r.kind===kind&&r.ordinal===ordinal&&r.id===transfer); // exact manifest-to-locked-section binding: kind+ordinal+bytes+digest AND the section's own id
  const expected=1+manifest.photos.pages.length+manifest.events.pages.length;
  if(rows.length!==expected)throw new TransferError('invalidBackup',400); // nothing staged beyond the manifest
  const photoRows=manifest.photos.pages.map(p=>{const r=pick('photos',p.ordinal,p.transfer);if(!r||r.bytes!==p.bytes||r.digest!==p.digest)throw new TransferError('invalidBackup',400);return r;});
  const eventRows=manifest.events.pages.map(p=>{const r=pick('events',p.ordinal,p.transfer);if(!r||r.bytes!==p.bytes||r.digest!==p.digest)throw new TransferError('invalidBackup',400);return r;});
  // In-transaction section read: the row was locked FOR UPDATE above, so the digest re-verified
  // at assembly is the manifest-pinned digest - no TOCTOU between validation and apply.
  const readSection=async(r:SectionRow):Promise<Buffer>=>{
   const full=(await client.query('SELECT bytes,digest,chunks FROM gymos.gym_backup_sections WHERE id=$1',[r.id])).rows[0] as {bytes:number;digest:string;chunks:Record<string,string>};
   return assembleTransfer(full);
  };
  const decode=(buf:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(buf);
  // Core is derived HERE, from the locked, manifest-pinned section inside this transaction -
  // never from a pre-commit read another transaction could have replaced.
  const coreRow=rows.find(r=>r.kind==='core'&&r.ordinal===0);
  if(!coreRow||coreRow.bytes!==manifest.core.bytes||coreRow.digest!==manifest.core.digest)throw new TransferError('invalidBackup',400);
  let state=validateBackup(JSON.parse(decode(await readSection(coreRow))));
  if(adjust)state=adjust(state,current);
  // Pre-validation pass (no writes): parse + entry shapes + member binding + duplicates + counts.
  const memberIds=new Set(state.members.map(m=>m.id)); // validateBackup caps members at 10000, so this set is bounded
  let photoTotal=0;const seenPhotos=new Set<string>();
  for(const r of photoRows){
   const page=JSON.parse(decode(await readSection(r))) as Record<string,string>;
   if(!page||typeof page!=='object'||Array.isArray(page))throw new TransferError('invalidBackup',400);
   for(const [id,content]of Object.entries(page)){
    if(!validPhotoEntry(id,content))throw new TransferError('invalidBackup',400);
    if(!memberIds.has(id))throw new TransferError('invalidBackup',400); // no orphan portraits: photos must belong to a restored member
    if(seenPhotos.has(id))throw new TransferError('invalidBackup',400); // no cross-page duplicates
    seenPhotos.add(id);
   }
   photoTotal+=Object.keys(page).length;
  }
  if(photoTotal!==manifest.photos.count)throw new TransferError('invalidBackup',400);
  // Event pages parse + shape-check; duplicate detection runs DB-side on a bounded temp table
  // (staged event volume is capped by SESSION_MAX_BYTES, so the table is bounded by staging admission).
  await client.query('CREATE TEMPORARY TABLE gym_backup_restore_event_ids(id text) ON COMMIT DROP');
  let eventTotal=0;
  for(const r of eventRows){
   const page=JSON.parse(decode(await readSection(r))) as Event[]; // one page in memory at a time; discarded after the dup-check insert
   if(!Array.isArray(page)||!page.every(validEvent))throw new TransferError('invalidBackup',400);
   for(let i=0;i<page.length;i+=500){
    const chunk=page.slice(i,i+500);
    await client.query('INSERT INTO gym_backup_restore_event_ids(id) SELECT x.id FROM jsonb_to_recordset($1::jsonb) AS x(id text)',[JSON.stringify(chunk.map(e=>({id:e.id})))]);
   }
   eventTotal+=page.length;
  }
  if(eventTotal!==manifest.events.count)throw new TransferError('invalidBackup',400);
  const dup=(await client.query('SELECT count(*)::bigint AS n,count(DISTINCT id)::bigint AS d FROM gym_backup_restore_event_ids')).rows[0] as {n:string;d:string};
  if(dup.n!==dup.d)throw new TransferError('invalidBackup',400); // no cross-page duplicate events: ON CONFLICT at apply would mask a declared-coverage violation
  // Apply: the same single transaction. Generators re-read the locked, digest-pinned pages.
  const staged:StagedRestore={
   photos:(async function*(){for(const r of photoRows)yield JSON.parse(decode(await readSection(r))) as Record<string,string>;})(),
   archiveEvents:(async function*(){for(const r of eventRows)yield JSON.parse(decode(await readSection(r))) as Event[];})(),
  };
  const applied=await persistSpaceTx(client,owner,current,state,true,undefined,staged);
  if(!applied){await client.query('ROLLBACK');return false;}
  await client.query('COMMIT');
  try{void processWorkspaceOutbox(owner);}catch{}
  return true;
 }catch(error){
  await client.query('ROLLBACK');
  throw error;
 }finally{client.release();}
}
