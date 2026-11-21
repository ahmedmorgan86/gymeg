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
}
export const MAX_SLICE=500;
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
    async count(owner,collection,branches){return scope(owner,async c=>{const r=(await c.query(branches?'SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 AND branch=ANY($3::text[])':'SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2',branches?[owner,collection,branches]:[owner,collection])).rows[0] as {n:number};return Number(r.n);});},
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

export type Sliced={state:GymState;revision:number;partial:true;/** Stored position of every loaded row, key `collection:entity_id`. Only readHotSlice fills it. */positions?:Record<string,number>};
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
    return{state:normalizeState(assembleState(meta.metadata,unique,{})),positions:Object.fromEntries(unique.map(e=>[e.collection+':'+e.entity_id,Number(e.position)]))};
  });
  return got&&got.value?{state:got.value.state,positions:got.value.positions,revision:got.revision,partial:true}:null;
}
