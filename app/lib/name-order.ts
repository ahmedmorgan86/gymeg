/**
 * Maintained name-order key (prototype, unwired, no schema). The members screen sorts by
 * a.name.localeCompare(b.name,'ar'), with ties kept in stored position order. Postgres collation can
 * not be assumed to match, and an O(N) name read per request is not acceptable as the end state.
 * Instead each member row carries a numeric key whose order equals (comparator, position) order.
 * A write finds its place with O(log) index seeks using the SAME comparator in application code,
 * so the order is whatever the server's ICU says, set once at write time. A page is then an index
 * range scan on (owner, key). When the key gap is exhausted the caller must renumber (rare, bounded
 * by the club's member count, and reported rather than hidden).
 */
export type NameItem={id:string;name:string;position:number;key:number};
export interface KeyStore{
  /** Greatest-key item with key <= k (excluding `except`), or null. */
  atOrBelow(k:number,except:string):Promise<NameItem|null>;
  /** Least-key item with key > k (excluding `except`), or null. */
  above(k:number,except:string):Promise<NameItem|null>;
}
export const KEY_MIN=-1e15,KEY_MAX=1e15,STEP=1e6;
const collator=new Intl.Collator('ar');
export const compareNames=(a:{name:string;position:number},b:{name:string;position:number})=>collator.compare(a.name,b.name)||a.position-b.position;
export const probes={n:0};
/** Key for `item` between its neighbors, or null when no distinct float lies between them (renumber needed). */
export async function assignKey(store:KeyStore,item:{id:string;name:string;position:number}):Promise<number|null>{
  let lo=KEY_MIN,hi=KEY_MAX; // search window in key space; every probe strictly shrinks it
  for(let guard=0;guard<200;guard++){
    probes.n++;
    const mid=lo+(hi-lo)/2;
    if(!(mid>lo&&mid<hi))return null;
    const below=await store.atOrBelow(mid,item.id),above=await store.above(mid,item.id);
    if(below&&compareNames(below,item)>0){hi=below.key;continue;} // item sorts before `below`
    if(above&&compareNames(above,item)<0){lo=above.key;continue;} // item sorts after `above`
    if(!below&&!above)return 0;
    if(!below)return above!.key-STEP>KEY_MIN?above!.key-STEP:null;
    if(!above)return below.key+STEP<KEY_MAX?below.key+STEP:null;
    const k=below.key+(above.key-below.key)/2;return k>below.key&&k<above.key?k:null;
  }
  return null;
}
/** Evenly spaced keys for a full renumber, in (comparator, position) order. */
export function renumber(items:{id:string;name:string;position:number}[]):Map<string,number>{
  const sorted=[...items].sort(compareNames);return new Map(sorted.map((x,i)=>[x.id,(i+1)*STEP]));
}
