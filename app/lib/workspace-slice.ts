import {RECENT_EVENTS} from './activity-archive.ts';
// Bounded workspace reads. readSpace() loads every collection of a club; most
// callers need the revision, the settings, one member, or one collection page.
// A SliceBackend reads exactly that and nothing more, on Postgres and Firestore.
import {createHash} from 'node:crypto';
import type {GymState} from './domain.ts';
import {assembleState,collections,type Entity} from './entity-state.ts';

export type Collection=typeof collections[number];
export type SliceQuery={
  /** Collections to read. Everything else stays empty in the returned state. */
  collections:Collection[];
  /** Branch scope pushed into the query. null/undefined means every branch. */
  branches?:string[]|null;
  /** Exact entity ids (requires exactly one collection). */
  ids?:string[];
  /** Only rows whose payload[field] is one of values (e.g. member for visits/payments/invoices, assignment for training sessions). */
  match?:{field:'member'|'assignment';values:string[]};
  /** Page cursor over `position`: rows strictly after / before it. */
  after?:number;before?:number;
  /** Newest-first when true (highest position first). */
  desc?:boolean;
  limit?:number;
  /** Only rows with no payload.leftAt (open visits). */
  open?:boolean;
};
export type Meta={metadata:Record<string,unknown>;revision:number};
/** The callers' full-state rule: JSON.stringify(full state) over 20,000,000 UTF-8 bytes answers 413 (app/api/workspace, backup and member-messages routes). */
export const STATE_BYTE_LIMIT=20_000_000;
export interface SliceBackend{
  /** True when `open:true` is answered by the query itself. Firestore cannot query a missing field, so it filters after fetching the branch history and reports false. */
  readonly supportsOpen:boolean;
  revision(owner:string):Promise<number|null>;
  meta(owner:string):Promise<Meta|null>;
  entities(owner:string,query:SliceQuery):Promise<Entity[]>;
  photo(owner:string,memberId:string):Promise<string|null>;
  /** member id -> first 16 hex chars of sha256(photo content), the cache-busting version the packet puts in photo URLs. */
  photoVersions(owner:string):Promise<Record<string,string>>;
  count(owner:string,collection:Collection,branches?:string[]|null):Promise<number>;
  /** True when some member row has more than 1000 freezes (the full path rejects every operation on such a club). Postgres answers from a tiny partial index. */
  hasOversizedFreezes(owner:string):Promise<boolean>;
  /** One read of the trigger-maintained counters: exact row counts per collection and a safe UPPER bound of JSON.stringify(full state) in bytes (never an exact size).
   * null when the counters are absent or not marked ready for this owner, so callers fall back to the full path. */
  counters(owner:string):Promise<{counts:Record<string,number>;bound:number}|null>;
}
export const MAX_SLICE=500;
/** Counters for an owner whose marker row says they were built from every row (a new owner, or after recount_entity_counters). null otherwise or when the migration is absent. */
export async function readCounters(c:{query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>},owner:string):Promise<{counts:Record<string,number>;rows:number;bytes:number}|null>{
  if(!(await c.query("SELECT to_regclass('gymos.gym_entity_counters') IS NOT NULL AS ok")).rows.some(r=>(r as {ok:boolean}).ok))return null;
  const rows=(await c.query('SELECT collection,row_count,payload_bytes FROM gymos.gym_entity_counters WHERE owner_id=$1',[owner])).rows as {collection:string;row_count:string|number;payload_bytes:string|number}[];
  if(!rows.some(r=>r.collection==='_ready'))return null;
  const counts:Record<string,number>={};let n=0,bytes=0;for(const r of rows){if(r.collection==='_ready')continue;const rc=Number(r.row_count),pb=Number(r.payload_bytes);if(!Number.isSafeInteger(rc)||!Number.isSafeInteger(pb)||rc<0||pb<0)return null; // corrupt or half-applied counters: fail closed
    counts[r.collection]=rc;n+=rc;bytes+=pb;if(!Number.isSafeInteger(n)||!Number.isSafeInteger(bytes))return null;}
  return{counts,rows:n,bytes};
}
export function checkQuery(q:SliceQuery){
  if(!q.collections.length)throw new Error('slice needs a collection');
  for(const c of q.collections)if(!collections.includes(c))throw new Error('Invalid collection');
  if(q.ids&&q.collections.length!==1)throw new Error('ids need one collection');
  if(q.match&&q.match.values.length===0)return false;
  if(q.branches&&q.branches.length===0)return false; // no branch allowed: nothing to read
  return true;
}
export const COMPLETE_MAX=250000;
/** Explicit page sizes are capped; a read with no limit means "all matching rows" and must fail loudly rather than truncate silently. */
const clampLimit=(n?:number)=>n===undefined?COMPLETE_MAX+1:Math.max(1,Math.min(MAX_SLICE,Math.floor(n)));
const complete=<T>(q:SliceQuery,rows:T[],per=1)=>{if(q.limit===undefined&&rows.length>COMPLETE_MAX*per)throw new Error('slice too large: page it');return rows;};

type Sql={query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>};
/** Postgres backend over gymos.gym_states / gym_entities / gym_photos. `scope` must set app.gym_owner (withScope does). */
export function postgresBackend(scope:<T>(owner:string,work:(client:Sql)=>Promise<T>)=>Promise<T>):SliceBackend{
  return{
    supportsOpen:true,
    async revision(owner){return scope(owner,async c=>{const r=(await c.query('SELECT revision FROM gymos.gym_states WHERE user_id=$1',[owner])).rows[0] as {revision:number}|undefined;return r?Number(r.revision):null;});},
    async meta(owner){return scope(owner,async c=>{const r=(await c.query('SELECT payload,revision FROM gymos.gym_states WHERE user_id=$1',[owner])).rows[0] as {payload:string;revision:number}|undefined;return r?{metadata:JSON.parse(r.payload),revision:Number(r.revision)}:null;});},
    async entities(owner,q){
      if(!checkQuery(q))return [];
      const values:unknown[]=[owner,q.collections];const where=['owner_id=$1','collection=ANY($2::text[])'];
      if(q.branches){values.push(q.branches);where.push(`branch=ANY($${values.length}::text[])`);}
      if(q.ids){values.push(q.ids);where.push(`entity_id=ANY($${values.length}::text[])`);}
      if(q.match){values.push(q.match.values);where.push(`payload->>'${q.match.field}'=ANY($${values.length}::text[])`);}
      if(q.open)where.push("payload->>'leftAt' IS NULL");
      if(q.after!==undefined){values.push(q.after);where.push(`position>$${values.length}`);}
      if(q.before!==undefined){values.push(q.before);where.push(`position<$${values.length}`);}
      values.push(clampLimit(q.limit));
      const sql=`SELECT collection,entity_id,position,branch,payload FROM gymos.gym_entities WHERE ${where.join(' AND ')} ORDER BY collection,position ${q.desc?'DESC':'ASC'} LIMIT $${values.length}`;
      return complete(q,await scope(owner,async c=>(await c.query(sql,values)).rows as Entity[]));
    },
    async photo(owner,memberId){return scope(owner,async c=>{const r=(await c.query('SELECT content FROM gymos.gym_photos WHERE owner_id=$1 AND member_id=$2',[owner,memberId])).rows[0] as {content:string}|undefined;return r?.content??null;});},
    async photoVersions(owner){return scope(owner,async c=>Object.fromEntries(((await c.query("SELECT member_id,left(encode(sha256(convert_to(content,'UTF8')),'hex'),16) AS v FROM gymos.gym_photos WHERE owner_id=$1",[owner])).rows as {member_id:string;v:string}[]).map(r=>[r.member_id,r.v])));},
    async counters(owner){return scope(owner,async c=>{const k=await readCounters(c,owner);if(!k)return null;const m=(await c.query('SELECT octet_length(payload) AS n FROM gymos.gym_states WHERE user_id=$1',[owner])).rows[0] as {n:number}|undefined;if(!m)return null;
      // metadata text + every row's payload (jsonb text >= compact JSON) + a comma per row + per-collection key and bracket overhead + photos
      return{counts:k.counts,bound:Number(m.n)+k.bytes+k.rows+4096};});},
    async hasOversizedFreezes(owner){return scope(owner,async c=>((await c.query("SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members' AND jsonb_typeof(payload->'freezes')='array' AND jsonb_array_length(payload->'freezes')>1000 LIMIT 1",[owner])).rows.length>0));},
    async count(owner,collection,branches){return scope(owner,async c=>{
      if(!branches){const fast=await readCounters(c,owner);if(fast)return fast.counts[collection]??0;}
      const r=(await c.query(branches?'SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 AND branch=ANY($3::text[])':'SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2',branches?[owner,collection,branches]:[owner,collection])).rows[0] as {n:number};return Number(r.n);});},
  };
}

type FsDoc={exists:boolean;data():unknown};
type FsQuery={where(f:string,op:string,v:unknown):FsQuery;orderBy(f:string,d?:string):FsQuery;startAfter(v:unknown):FsQuery;limit(n:number):FsQuery;get():Promise<{docs:{data():unknown}[]}>;count?():{get():Promise<{data():{count:number}}>}};
type FsDb={collection(name:string):FsQuery&{doc(id:string):{get():Promise<FsDoc>}}};
/** Firestore backend. Entity ids are deterministic (`owner_collection_id`), so id lookups are direct document gets. */
export function firestoreBackend(getDb:()=>FsDb,opts:{indexed?:boolean}={}):SliceBackend{
  const indexed=opts.indexed!==false;
  return{
    supportsOpen:false,
    async revision(owner){const s=await getDb().collection('gym_states').doc(owner).get();return s.exists?Number((s.data() as {revision?:number}).revision??0):null;},
    async meta(owner){if(!indexed)return null; // composite indexes not confirmed: callers fall back to the full read
      const s=await getDb().collection('gym_states').doc(owner).get();if(!s.exists)return null;const d=s.data() as {payload:string;revision:number};return{metadata:JSON.parse(d.payload),revision:Number(d.revision)};},
    async entities(owner,q){
      if(!checkQuery(q))return [];
      if(!indexed)throw new Error('firestore slice indexes not enabled');
      const db=getDb();
      if(q.ids){const c=q.collections[0];const snaps=await Promise.all(q.ids.slice(0,MAX_SLICE).map(id=>db.collection('gym_entities').doc(`${owner}_${c}_${id}`).get()));return snaps.filter(s=>s.exists).map(s=>s.data() as Entity).filter(e=>!q.open||!(e.payload as {leftAt?:unknown}).leftAt).filter(e=>!q.branches||(e.branch!==null&&q.branches.includes(e.branch)));}
      const out:Entity[]=[];
      for(const c of q.collections){
        // Firestore `in` allows 30 values; larger branch lists are queried in chunks.
        const groups=q.branches?Array.from({length:Math.ceil(q.branches.length/30)},(_,i)=>q.branches!.slice(i*30,i*30+30)):[null];
        const chunks=<T>(a:T[]|undefined)=>a?Array.from({length:Math.ceil(a.length/30)},(_,i)=>a.slice(i*30,i*30+30)):[undefined];
        for(const g of groups)for(const m of chunks(q.match?.values)){
          let query=db.collection('gym_entities').where('owner_id','==',owner).where('collection','==',c);
          if(g)query=query.where('branch','in',g);
          if(q.match&&m)query=query.where('payload.'+q.match.field,'in',m);
          query=query.orderBy('position',q.desc?'desc':'asc');
          if(q.after!==undefined&&!q.desc)query=query.startAfter(q.after);
          if(q.before!==undefined&&q.desc)query=query.startAfter(q.before);
          if(q.after!==undefined&&q.desc)query=query.where('position','>',q.after);
          if(q.before!==undefined&&!q.desc)query=query.where('position','<',q.before);
          out.push(...(await query.limit(clampLimit(q.limit)).get()).docs.map(d=>d.data() as Entity));
        }
      }
      const sorted=out.sort((a,b)=>a.collection.localeCompare(b.collection)||(q.desc?b.position-a.position:a.position-b.position));
      const kept=q.open?sorted.filter(e=>!(e.payload as {leftAt?:unknown}).leftAt):sorted;
      return complete(q,kept.slice(0,clampLimit(q.limit)*q.collections.length),q.collections.length);
    },
    async photo(owner,memberId){const s=await getDb().collection('gym_photos').doc(`${owner}_${memberId}`).get();return s.exists?String((s.data() as {content:string}).content):null;},
    async photoVersions(owner){const snap=await getDb().collection('gym_photos').where('owner_id','==',owner).get();return Object.fromEntries(snap.docs.map(d=>{const x=d.data() as {member_id:string;content:string};return[x.member_id,createHash('sha256').update(x.content).digest('hex').slice(0,16)];}));},
    async hasOversizedFreezes(){return true;}, // fail closed: Firestore never takes the hot path
    async counters(){return null;},
    async count(owner,collection,branches){
      const db=getDb();let total=0;
      const groups=branches?Array.from({length:Math.ceil(branches.length/30)},(_,i)=>branches.slice(i*30,i*30+30)):[null];
      for(const g of groups){let q=db.collection('gym_entities').where('owner_id','==',owner).where('collection','==',collection);if(g)q=q.where('branch','in',g);total+=q.count?(await q.count().get()).data().count:(await q.get()).docs.length;}
      return total;
    },
  };
}


/**
 * Snapshot guard: meta and entity rows are separate reads. Every commit bumps the
 * revision in the same transaction as its row writes, so if the revision is
 * unchanged after the reads, no commit landed in between. After a few changed
 * revisions this returns null and callers use the single-snapshot full read.
 */
export async function consistently<T>(be:SliceBackend,owner:string,work:(meta:Meta)=>Promise<T>):Promise<{value:T;revision:number}|null>{
  for(let attempt=0;attempt<3;attempt++){
    const meta=await be.meta(owner);
    if(!meta||meta.metadata._entityStorage!==1)return null;
    const value=await work(meta);
    if(await be.revision(owner)===meta.revision)return{value,revision:meta.revision};
  }
  return null;
}

export type Sliced={state:GymState;revision:number;partial:true;/** Stored position of every loaded row, key `collection:entity_id`. Only readHotSlice fills it. */positions?:Record<string,number>;/** Global row counts read in the same revision-checked snapshot. Only readHotSlice fills it. */counts?:{members:number;visits:number;invoices:number;plans:number;followUps:number}};
/** Revision only: one row / one document. null when the club has no state yet. */
export const readRevisionOnly=(be:SliceBackend,owner:string)=>be.revision(owner);
/**
 * Settings + requested collections. Returns null when the club still uses the
 * legacy single-payload layout (no entity rows to slice): callers then fall
 * back to the full read. Every other collection is an empty array.
 */
export async function readSlice(be:SliceBackend,owner:string,query:SliceQuery|SliceQuery[]|null|((metadata:Record<string,unknown>)=>SliceQuery[]),normalizeState:(s:GymState)=>GymState=s=>s):Promise<Sliced|null>{
  const got=await consistently(be,owner,async meta=>{
    const queries=query===null?[]:typeof query==='function'?query(meta.metadata):Array.isArray(query)?query:[query];
    const rows=(await Promise.all(queries.map(q=>be.entities(owner,q)))).flat();
    return normalizeState(assembleState(meta.metadata,rows,{}));
  });
  return got?{state:got.value,revision:got.revision,partial:true}:null;
}

/**
 * Everything the member portal view reads for one member: the member, that
 * member's own rows, the branch's small reference collections, and only the
 * programs/sessions their assignments point at. Checked against memberView over
 * the full state in tests. Returns null for legacy single-payload clubs.
 */
export async function readMemberSlice(be:SliceBackend,owner:string,memberId:string,branch:string,normalizeState:(s:GymState)=>GymState=s=>s):Promise<Sliced|null>{
  if(!be.supportsOpen)return null; // occupancy needs open visits; without a bounded query use the full read
  const got=await consistently(be,owner,async meta=>{
    const own=(c:Collection):SliceQuery=>({collections:[c],match:{field:'member',values:[memberId]},branches:[branch]});
    const first=(await Promise.all([
      be.entities(owner,{collections:['members'],ids:[memberId],branches:[branch]}),
      ...(['visits','payments','invoices','trainingAssignments','coaching'] as Collection[]).map(c=>be.entities(owner,own(c))),
      be.entities(owner,{collections:['plans','classes','shifts'],branches:[branch]}),
      // Branch occupancy: open visits only, then every visit of those members so the
      // "latest visit per member" rule matches presentVisits over the full state.
      be.entities(owner,{collections:['visits'],branches:[branch],open:true}),
    ])).flat();
    const openMembers=[...new Set(first.filter(e=>e.collection==='visits'&&!(e.payload as {leftAt?:unknown}).leftAt).map(e=>String(e.payload.member)))];
    const assignments=first.filter(e=>e.collection==='trainingAssignments');
    const programIds=[...new Set(assignments.map(e=>String(e.payload.program)))],assignmentIds=assignments.map(e=>e.entity_id);
    const coachIds=[...new Set(first.filter(e=>e.collection==='coaching').map(e=>String(e.payload.coach)))];
    const second=(await Promise.all([
      programIds.length?be.entities(owner,{collections:['programs'],ids:programIds,branches:[branch]}):[],
      assignmentIds.length?be.entities(owner,{collections:['trainingSessions'],match:{field:'assignment',values:assignmentIds},branches:[branch]}):[],
      coachIds.length?be.entities(owner,{collections:['coaches'],ids:coachIds}):[],
      openMembers.length?be.entities(owner,{collections:['visits'],match:{field:'member',values:openMembers},branches:[branch]}):[],
      openMembers.length?be.entities(owner,{collections:['members'],ids:openMembers,branches:[branch]}):[],
    ])).flat();
    const seen=new Set<string>(),rows=[...first,...second].filter(e=>{const k=e.collection+'\0'+e.entity_id;if(seen.has(k))return false;seen.add(k);return true;});
    return normalizeState(assembleState(meta.metadata,rows,{}));
  });
  return got?{state:got.value,revision:got.revision,partial:true}:null;
}

/** Row caps for the hot-operation hydration. Past a cap, completeness is not established and the caller uses the full read. */
export const HOT_OPEN_CAP=2000,HOT_MEMBER_CAP=5000;
async function pagedAll(be:SliceBackend,owner:string,q:SliceQuery,cap:number):Promise<Entity[]|null>{
  const out:Entity[]=[];let after:number|undefined;
  for(;;){
    const page=await be.entities(owner,{...q,limit:MAX_SLICE,...(after!==undefined?{after}:{})});
    out.push(...page);
    if(out.length>cap)return null;
    if(page.length<MAX_SLICE)return out;
    after=page[page.length-1].position;
  }
}
/**
 * Rows hot-op-plans.ts partialState() keeps, read from storage. Returns null for
 * legacy layouts, a changing club, or when open visits or
 * the member's history exceed the caps; callers then use the full read. A visit id that does
 * not resolve gives a member-less state, the same as partialState(), so the operation fails notFound exactly as on the full state.
 */
export async function readHotSlice(be:SliceBackend,owner:string,plan:{branch:string;member?:string;visit?:string},normalizeState:(s:GymState)=>GymState=s=>s):Promise<Sliced|null>{
  if(!be.supportsOpen)return null;
  const got=await consistently(be,owner,async meta=>{
    let member=plan.member;
    if(!member){
      const v=await be.entities(owner,{collections:['visits'],ids:[String(plan.visit)],branches:[plan.branch]});
      member=v[0]?String(v[0].payload.member):undefined;
    }
    if(await be.hasOversizedFreezes(owner))return null;
    const open=await pagedAll(be,owner,{collections:['visits'],open:true},HOT_OPEN_CAP);
    if(!open)return null;
    const rows:Entity[]=[...open];
    if(member){
      const own=(c:Collection)=>pagedAll(be,owner,{collections:[c],match:{field:'member',values:[member!]}},HOT_MEMBER_CAP);
      const [visits,payments,invoices,members]=await Promise.all([own('visits'),own('payments'),own('invoices'),be.entities(owner,{collections:['members'],ids:[member],branches:[plan.branch]})]);
      if(!visits||!payments||!invoices)return null;
      rows.push(...visits,...payments,...invoices,...members);
    }
    rows.push(...await be.entities(owner,{collections:['plans','shifts'],branches:[plan.branch]}));
    const seen=new Set<string>(),unique=rows.filter(e=>{const k=e.collection+'\0'+e.entity_id;if(seen.has(k))return false;seen.add(k);return true;});
    // One counters read gives exact counts and the size bound; without it (absent migration, unready owner, Firestore) the hot path stays off.
    const k=await be.counters(owner);if(!k)return null;
    const n=(c:string)=>k.counts[c]??0,counts={members:n('members'),visits:n('visits'),invoices:n('invoices'),plans:n('plans'),followUps:n('followUps')};
    // At the trim windows the full path's own positions tie (array index vs retained rows): fail closed until a shared ordering fix is reviewed.
    if(n('events')>=RECENT_EVENTS||n('receipts')>=1000)return null;
    // The caller rejects full states over STATE_BYTE_LIMIT; the hot path never runs that check. Here only an already-over bound is refused.
    if(k.bound>STATE_BYTE_LIMIT)return null; // the exact growth check for the proposed write runs inside persistSpace's transaction
    return{counts,state:normalizeState(assembleState(meta.metadata,unique,{})),positions:Object.fromEntries(unique.map(e=>[e.collection+':'+e.entity_id,Number(e.position)]))};
  });
  return got&&got.value?{state:got.value.state,positions:got.value.positions,counts:got.value.counts,revision:got.revision,partial:true}:null;
}
