/**
 * Shared client-side image encoder: draws a decoded source onto a canvas and
 * re-encodes it as a small data URL. Prefers WebP (every Android WebView and
 * modern browser encodes it); falls back to JPEG where the canvas encoder
 * lacks WebP (old Safari). Transparent logos stay PNG elsewhere on purpose.
 *
 * Plain function declarations only: the test loaders parse every .ts file as
 * TSX, where generic arrow syntax breaks.
 */

export interface EncodeImageOptions {
  /** Output width in pixels (exact when `crop`, otherwise the maximum). */
  width: number;
  /** Output height in pixels (exact when `crop`, otherwise the maximum). */
  height: number;
  /** Center-crop the source to the exact width x height box. */
  crop?: boolean;
  /** Opaque background fill; required because JPEG output has no alpha. */
  background?: string;
  /** Maximum accepted data-URL length in characters. */
  byteCap: number;
  /** Quality ladder, best first; the first value under the cap wins. */
  qualities?: number[];
}

export type EncodeImageSource =
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | ImageBitmap;

interface SourceSize {
  width: number;
  height: number;
}

function sourceSize(source: EncodeImageSource): SourceSize {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: source.width, height: source.height };
}

const WEBP_PREFIX = 'data:image/webp;base64,';
let cachedWebpSupport: boolean | null = null;

/** True when this browser's canvas can encode WebP. Cached after first check. */
export function supportsWebpEncode(): boolean {
  if (cachedWebpSupport === null) {
    const probe = document.createElement('canvas');
    probe.width = 2;
    probe.height = 2;
    cachedWebpSupport = probe.toDataURL('image/webp', 0.5).startsWith(WEBP_PREFIX);
  }
  return cachedWebpSupport;
}

/** MIME type the encoder will produce in this browser. */
export function preferredImageMime(): 'image/webp' | 'image/jpeg' {
  return supportsWebpEncode() ? 'image/webp' : 'image/jpeg';
}

/**
 * Encode `source` into a bounded data URL. Throws Error('photoDimensions')
 * for empty or absurd sources and Error('photoSize') when no ladder rung fits
 * under the byte cap.
 */
export function encodeImage(
  source: EncodeImageSource,
  options: EncodeImageOptions,
): string {
  const size = sourceSize(source);
  if (!size.width || !size.height || size.width * size.height > 40_000_000) {
    throw Error('photoDimensions');
  }
  const canvas = document.createElement('canvas');
  if (options.crop) {
    canvas.width = options.width;
    canvas.height = options.height;
  } else {
    const scale = Math.min(
      1,
      options.width / size.width,
      options.height / size.height,
    );
    canvas.width = Math.max(1, Math.round(size.width * scale));
    canvas.height = Math.max(1, Math.round(size.height * scale));
  }
  const context = canvas.getContext('2d');
  if (!context) throw Error('photoDimensions');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (options.crop) {
    const side = Math.min(size.width, size.height);
    context.drawImage(
      source,
      (size.width - side) / 2,
      (size.height - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  } else {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  const mime = preferredImageMime();
  const ladder = options.qualities ?? [0.8, 0.65, 0.5, 0.35];
  for (const quality of ladder) {
    const value = canvas.toDataURL(mime, quality);
    if (value.startsWith(`data:${mime};base64,`) && value.length <= options.byteCap) {
      return value;
    }
  }
  throw Error('photoSize');
}
