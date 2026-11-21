// Bounded workspace reads. readSpace() loads every collection of a club; most
// callers need the revision, the settings, one member, or one collection page.
// A SliceBackend reads exactly that and nothing more, on Postgres and Firestore.
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
  /** Page cursor over `position`: rows strictly after / before it. */
  after?:number;before?:number;
  /** Newest-first when true (highest position first). */
  desc?:boolean;
  limit?:number;
};
export type Meta={metadata:Record<string,unknown>;revision:number};
export interface SliceBackend{
  revision(owner:string):Promise<number|null>;
  meta(owner:string):Promise<Meta|null>;
  entities(owner:string,query:SliceQuery):Promise<Entity[]>;
  photo(owner:string,memberId:string):Promise<string|null>;
  count(owner:string,collection:Collection,branches?:string[]|null):Promise<number>;
}
export const MAX_SLICE=500;
export function checkQuery(q:SliceQuery){
  if(!q.collections.length)throw new Error('slice needs a collection');
  for(const c of q.collections)if(!collections.includes(c))throw new Error('Invalid collection');
  if(q.ids&&q.collections.length!==1)throw new Error('ids need one collection');
  if(q.branches&&q.branches.length===0)return false; // no branch allowed: nothing to read
  return true;
}
const clampLimit=(n?:number)=>Math.max(1,Math.min(MAX_SLICE,Math.floor(n??MAX_SLICE)));

type Sql={query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>};
/** Postgres backend over gymos.gym_states / gym_entities / gym_photos. `scope` must set app.gym_owner (withScope does). */
export function postgresBackend(scope:<T>(owner:string,work:(client:Sql)=>Promise<T>)=>Promise<T>):SliceBackend{
  return{
    async revision(owner){return scope(owner,async c=>{const r=(await c.query('SELECT revision FROM gymos.gym_states WHERE user_id=$1',[owner])).rows[0] as {revision:number}|undefined;return r?Number(r.revision):null;});},
    async meta(owner){return scope(owner,async c=>{const r=(await c.query('SELECT payload,revision FROM gymos.gym_states WHERE user_id=$1',[owner])).rows[0] as {payload:string;revision:number}|undefined;return r?{metadata:JSON.parse(r.payload),revision:Number(r.revision)}:null;});},
    async entities(owner,q){
      if(!checkQuery(q))return [];
      const values:unknown[]=[owner,q.collections];const where=['owner_id=$1','collection=ANY($2::text[])'];
      if(q.branches){values.push(q.branches);where.push(`branch=ANY($${values.length}::text[])`);}
      if(q.ids){values.push(q.ids);where.push(`entity_id=ANY($${values.length}::text[])`);}
      if(q.after!==undefined){values.push(q.after);where.push(`position>$${values.length}`);}
      if(q.before!==undefined){values.push(q.before);where.push(`position<$${values.length}`);}
      values.push(clampLimit(q.limit));
      const sql=`SELECT collection,entity_id,position,branch,payload FROM gymos.gym_entities WHERE ${where.join(' AND ')} ORDER BY collection,position ${q.desc?'DESC':'ASC'} LIMIT $${values.length}`;
      return scope(owner,async c=>(await c.query(sql,values)).rows as Entity[]);
    },
    async photo(owner,memberId){return scope(owner,async c=>{const r=(await c.query('SELECT content FROM gymos.gym_photos WHERE owner_id=$1 AND member_id=$2',[owner,memberId])).rows[0] as {content:string}|undefined;return r?.content??null;});},
    async count(owner,collection,branches){return scope(owner,async c=>{const r=(await c.query(branches?'SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 AND branch=ANY($3::text[])':'SELECT count(*)::int AS n FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2',branches?[owner,collection,branches]:[owner,collection])).rows[0] as {n:number};return Number(r.n);});},
  };
}

type FsDoc={exists:boolean;data():unknown};
type FsQuery={where(f:string,op:string,v:unknown):FsQuery;orderBy(f:string,d?:string):FsQuery;startAfter(v:unknown):FsQuery;limit(n:number):FsQuery;get():Promise<{docs:{data():unknown}[]}>;count?():{get():Promise<{data():{count:number}}>}};
type FsDb={collection(name:string):FsQuery&{doc(id:string):{get():Promise<FsDoc>}}};
/** Firestore backend. Entity ids are deterministic (`owner_collection_id`), so id lookups are direct document gets. */
export function firestoreBackend(getDb:()=>FsDb):SliceBackend{
  return{
    async revision(owner){const s=await getDb().collection('gym_states').doc(owner).get();return s.exists?Number((s.data() as {revision?:number}).revision??0):null;},
    async meta(owner){const s=await getDb().collection('gym_states').doc(owner).get();if(!s.exists)return null;const d=s.data() as {payload:string;revision:number};return{metadata:JSON.parse(d.payload),revision:Number(d.revision)};},
    async entities(owner,q){
      if(!checkQuery(q))return [];
      const db=getDb();
      if(q.ids){const c=q.collections[0];const snaps=await Promise.all(q.ids.slice(0,MAX_SLICE).map(id=>db.collection('gym_entities').doc(`${owner}_${c}_${id}`).get()));return snaps.filter(s=>s.exists).map(s=>s.data() as Entity).filter(e=>!q.branches||(e.branch!==null&&q.branches.includes(e.branch)));}
      const out:Entity[]=[];
      for(const c of q.collections){
        // Firestore `in` allows 30 values; larger branch lists are queried in chunks.
        const groups=q.branches?Array.from({length:Math.ceil(q.branches.length/30)},(_,i)=>q.branches!.slice(i*30,i*30+30)):[null];
        for(const g of groups){
          let query=db.collection('gym_entities').where('owner_id','==',owner).where('collection','==',c);
          if(g)query=query.where('branch','in',g);
          query=query.orderBy('position',q.desc?'desc':'asc');
          if(q.after!==undefined&&!q.desc)query=query.startAfter(q.after);
          if(q.before!==undefined&&q.desc)query=query.startAfter(q.before);
          if(q.after!==undefined&&q.desc)query=query.where('position','>',q.after);
          if(q.before!==undefined&&!q.desc)query=query.where('position','<',q.before);
          out.push(...(await query.limit(clampLimit(q.limit)).get()).docs.map(d=>d.data() as Entity));
        }
      }
      const sorted=out.sort((a,b)=>a.collection.localeCompare(b.collection)||(q.desc?b.position-a.position:a.position-b.position));
      return sorted.slice(0,clampLimit(q.limit)*q.collections.length);
    },
    async photo(owner,memberId){const s=await getDb().collection('gym_photos').doc(`${owner}_${memberId}`).get();return s.exists?String((s.data() as {content:string}).content):null;},
    async count(owner,collection,branches){
      const db=getDb();let total=0;
      const groups=branches?Array.from({length:Math.ceil(branches.length/30)},(_,i)=>branches.slice(i*30,i*30+30)):[null];
      for(const g of groups){let q=db.collection('gym_entities').where('owner_id','==',owner).where('collection','==',collection);if(g)q=q.where('branch','in',g);total+=q.count?(await q.count().get()).data().count:(await q.get()).docs.length;}
      return total;
    },
  };
}

export type Sliced={state:GymState;revision:number;partial:true};
/** Revision only: one row / one document. null when the club has no state yet. */
export const readRevisionOnly=(be:SliceBackend,owner:string)=>be.revision(owner);
/**
 * Settings + requested collections. Returns null when the club still uses the
 * legacy single-payload layout (no entity rows to slice): callers then fall
 * back to the full read. Every other collection is an empty array.
 */
export async function readSlice(be:SliceBackend,owner:string,query:SliceQuery|null,normalizeState:(s:GymState)=>GymState=s=>s):Promise<Sliced|null>{
  const meta=await be.meta(owner);
  if(!meta||meta.metadata._entityStorage!==1)return null;
  const rows=query?await be.entities(owner,query):[];
  const state=normalizeState(assembleState(meta.metadata,rows,{}));
  return{state,revision:meta.revision,partial:true};
}
