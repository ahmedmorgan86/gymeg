import { encodeImage } from './image-encode.ts';

export function validateMemberPhotoFile(file: Pick<File, 'type' | 'size'>) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 1 || file.size > 12 * 1024 * 1024) throw Error('photoFile');
}

/** Decode locally and re-encode pixels as a small WebP (JPEG on old browsers), stripping source metadata. */
export async function memberPhotoFromFile(file: File) {
  validateMemberPhotoFile(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new window.Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(Error('photoDecode'));
      image.src = url;
    });
    return encodeImage(image, {
      width: 160,
      height: 160,
      crop: true,
      background: '#ffffff',
      byteCap: 22000,
      qualities: [0.8, 0.65, 0.5, 0.35],
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
