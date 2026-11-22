import type {GymState} from './domain';

/** Separate per-owner aggregate photo budget in data-URL characters (= bytes; base64 is ASCII). Photos are NOT counted toward STATE_BYTE_LIMIT because the entity layout never stores them in the core JSON (gym_states.payload); they live in gymos.gym_photos and are bounded here instead. Sized so the worst backup (core <=20MB + photos) stays under BACKUP_MAX_BYTES (64MB): 40,000,000 chars covers ~416 max-size (96,000) or ~800-1,200 typical photos per owner. */
export const PHOTO_TOTAL_BYTE_LIMIT=40_000_000;
/** Thrown inside the persist transaction when the owner's stored photos exceed PHOTO_TOTAL_BYTE_LIMIT; the whole write rolls back, so the prior state stays intact. */
export class PhotoQuotaExceeded extends Error{constructor(){super('photo quota exceeded');}}
const coreBytesEncoder=new TextEncoder();
/** Byte size of the state JSON with member photo bodies subtracted: what the entity layout actually persists in the core envelope (photos live in gymos.gym_photos, bounded by PHOTO_TOTAL_BYTE_LIMIT). Slight overestimate: per-photo JSON field overhead stays counted, so callers refuse a little early. */
export function coreStateBytes(state:GymState){let photos=0;for(const m of state.members){const p=(m as {photo?:unknown}).photo;if(typeof p==='string')photos+=coreBytesEncoder.encode(p).length;}return coreBytesEncoder.encode(JSON.stringify(state)).length-photos;}
