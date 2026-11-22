export function validateMemberPhotoFile(file:Pick<File,'type'|'size'>){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size<1||file.size>12*1024*1024)throw Error('photoFile');
}
/** Member photo contract: 320x320 JPEG, preferred quality 0.85. Cap 96,000 data-URL
 * chars (~72 KB binary): measured worst case for 320px q85 on busy real photos was
 * ~49 KB data-URL (mozjpeg) and ~98 KB on synthetic noise in Chrome; the ladder
 * below absorbs that tail. Shared with domain/backup validation and the
 * gymos.gym_photos CHECK constraint - change all together. */
export const MEMBER_PHOTO_MAX=96000;
export const MEMBER_PHOTO_SIZE=320;
const MEMBER_PHOTO_QUALITIES=[.85,.75,.65] as const;
/** Shared encoder for both capture and upload: same size, same ladder, same cap.
 * Tries the approved quality first, degrades only when the result would exceed
 * the cap, and throws photoSize when even the last rung is too large. */
export function encodeMemberPhoto(draw:(ctx:CanvasRenderingContext2D,size:number)=>void){
 const canvas=document.createElement('canvas');canvas.width=MEMBER_PHOTO_SIZE;canvas.height=MEMBER_PHOTO_SIZE;const ctx=canvas.getContext('2d');if(!ctx)throw Error('photoDecode');
 ctx.fillStyle='#ffffff';ctx.fillRect(0,0,MEMBER_PHOTO_SIZE,MEMBER_PHOTO_SIZE);draw(ctx,MEMBER_PHOTO_SIZE);
 for(const quality of MEMBER_PHOTO_QUALITIES){const value=canvas.toDataURL('image/jpeg',quality);if(/^data:image\/jpeg;base64,\/9j\//.test(value)&&value.length<=MEMBER_PHOTO_MAX)return value;}
 throw Error('photoSize');
}
/** Decode locally and re-encode pixels as a JPEG, stripping source metadata. */
export async function memberPhotoFromFile(file:File){
 validateMemberPhotoFile(file);const url=URL.createObjectURL(file);
 try{
  const image=new window.Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(Error('photoDecode'));image.src=url;});
  const w=image.naturalWidth,h=image.naturalHeight;if(!w||!h||w*h>40_000_000)throw Error('photoDimensions');
  const side=Math.min(w,h);
  return encodeMemberPhoto((ctx,size)=>ctx.drawImage(image,(w-side)/2,(h-side)/2,side,side,0,0,size,size));
 }finally{URL.revokeObjectURL(url);}
}
