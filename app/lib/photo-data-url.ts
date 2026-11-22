/** Byte-level validation of stored photo data URLs.
 *
 * JPEG keeps the EXACT legacy rule (prefix regex plus the caller's length cap), so nothing a
 * legacy client or backup could store is rejected. WebP is new and is checked on its decoded
 * bytes, not by prefix: strict padded base64, RIFF container whose declared size equals the
 * real size, a single lossy (VP8) or lossless (VP8L) image chunk whose declared size closes the
 * file exactly, a valid bitstream signature, and dimensions inside the caller's bound.
 * VP8X (extended: animation, alpha, EXIF/ICC/XMP metadata chunks) is refused, so a stored photo
 * can never carry metadata or frames.
 *
 * The container check is NOT a decode: a fabricated header with no valid bitstream passes it. Full decode is photo-decode.ts (server).
 *
 * Pure functions, no Buffer or atob: this runs in the browser, in domain.ts and on the server. */
export type PhotoKind='jpeg'|'webp';
/** WebP admission is HELD: with the flag unset every validator behaves exactly like the legacy JPEG-only rule.
 * NEXT_PUBLIC_PHOTO_WEBP=1 turns it on (read per call so tests can toggle it). Do not enable until every restore
 * path (v2, v3 pages, hot ops) is proven and server-side full decode runs at each admission point (photo-decode.ts). */
export function photoWebpEnabled(){return typeof process!=='undefined'&&process.env.NEXT_PUBLIC_PHOTO_WEBP==='1';}
const JPEG=/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/=]+$/;
const WEBP=/^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/;
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function head(b64:string,bytes:number){
 const out:number[]=[];
 for(let i=0;i+3<b64.length&&out.length<bytes;i+=4){
  const a=ALPHABET.indexOf(b64[i]),b=ALPHABET.indexOf(b64[i+1]),c=ALPHABET.indexOf(b64[i+2]),d=ALPHABET.indexOf(b64[i+3]);
  out.push((a<<2)|(b>>4),((b&15)<<4)|(c>>2),((c&3)<<6)|d);
 }
 return out;
}
const u32=(h:number[],o:number)=>(h[o]|(h[o+1]<<8)|(h[o+2]<<16)|(h[o+3]<<24))>>>0;
const tag=(h:number[],o:number)=>String.fromCharCode(h[o],h[o+1],h[o+2],h[o+3]);
/** Returns 'jpeg' | 'webp' when the value is an acceptable photo, otherwise null.
 * `max` is the data-URL character cap, `maxSide` the largest accepted WebP width/height. */
export function photoDataUrlKind(value:unknown,max:number,maxSide:number):PhotoKind|null{
 if(typeof value!=='string'||value.length>max)return null;
 if(JPEG.test(value))return 'jpeg';
 if(!photoWebpEnabled())return null;
 const m=WEBP.exec(value);if(!m)return null;
 const b64=m[1];if(b64.length%4!==0)return null;
 const pad=b64.endsWith('==')?2:b64.endsWith('=')?1:0;
 const total=b64.length/4*3-pad;
 if(total<30)return null;
 const h=head(b64,32);
 if(tag(h,0)!=='RIFF'||tag(h,8)!=='WEBP')return null;
 if(u32(h,4)!==total-8)return null;
 const kind=tag(h,12),size=u32(h,16);
 if(kind!=='VP8 '&&kind!=='VP8L')return null;
 if(20+size+(size&1)!==total)return null;
 let w:number,hgt:number;
 if(kind==='VP8 '){
  if(h[23]!==0x9d||h[24]!==0x01||h[25]!==0x2a)return null;
  if((h[20]&1)!==0)return null; // key frame
  w=(h[26]|(h[27]<<8))&0x3fff;hgt=(h[28]|(h[29]<<8))&0x3fff;
 }else{
  if(h[20]!==0x2f)return null;
  const bits=u32(h,21);w=(bits&0x3fff)+1;hgt=((bits>>>14)&0x3fff)+1;
  if(((bits>>>28)&1)!==0)return null; // alpha_is_used: stored photos are drawn on an opaque background (same policy as the VP8X refusal)
 }
 if(w<1||hgt<1||w>maxSide||hgt>maxSide)return null;
 return 'webp';
}
export function isPhotoDataUrl(value:unknown,max:number,maxSide:number){return photoDataUrlKind(value,max,maxSide)!==null;}
/** Content type and bytes for serving a stored photo; null when it is not acceptable. */
export function photoResponse(value:unknown,max:number,maxSide:number):{type:'image/jpeg'|'image/webp';data:Buffer<ArrayBuffer>}|null{
 const kind=photoDataUrlKind(value,max,maxSide);if(!kind)return null;
 return {type:kind==='webp'?'image/webp':'image/jpeg',data:Buffer.from((value as string).split(',')[1],'base64')};
}
