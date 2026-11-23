/** Optional server-only demand canary containment. Missing scope preserves existing
 * flag semantics. When present (including empty), only exact storage owner IDs pass.
 * Never pass tenant headers or query parameters here, only authenticated ctx.owner.
 */
export function demandOwnerAllowed(owner:string,env:Record<string,string|undefined>=process.env):boolean{
 const raw=env.GYMOS_DEMAND_ALLOWED_OWNERS;
 if(raw===undefined)return true;
 const owners=raw.split(',').map(x=>x.trim()).filter(Boolean);
 return owners.includes(owner);
}
