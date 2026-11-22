import sharp from 'sharp';
import {photoDataUrlKind,type PhotoKind} from './photo-data-url.ts';
/** SERVER ONLY. Full decode of a stored photo data URL: the structural check first (cheap, bounded), then libvips decodes every pixel.
 * Rejects a corrupt or fabricated bitstream, animation (more than one page), a wrong format or size, and anything that does not
 * decode to the declared dimensions. Resolves to the kind, or null. Never throws. Must run at every WebP admission point before
 * NEXT_PUBLIC_PHOTO_WEBP is enabled; it is not wired into any route by this delta. */
export async function decodedPhotoKind(value:unknown,max:number,maxSide:number):Promise<PhotoKind|null>{
 const kind=photoDataUrlKind(value,max,maxSide);if(!kind)return null;
 try{
  const bytes=Buffer.from((value as string).split(',')[1],'base64');
  const image=sharp(bytes,{limitInputPixels:maxSide*maxSide*4,failOn:'error',pages:1});
  const meta=await image.metadata();
  if(meta.format!==(kind==='webp'?'webp':'jpeg')||(meta.pages??1)!==1||(kind==='webp'&&meta.hasAlpha)||!meta.width||!meta.height||(kind==='webp'&&(meta.width>maxSide||meta.height>maxSide)))return null;
  const {info}=await image.clone().raw().toBuffer({resolveWithObject:true});
  return info.width===meta.width&&info.height===meta.height?kind:null;
 }catch{return null;}
}
