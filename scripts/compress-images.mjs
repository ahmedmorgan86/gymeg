import {readFileSync, statSync} from 'node:fs';
import {validateBackup} from '../app/lib/backup.ts';
import {writeNewFile} from './safe-write.mjs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {photoDataUrlKind} from '../app/lib/photo-data-url.ts';
import {decodedPhotoKind} from '../app/lib/photo-decode.ts';
import {MEMBER_PHOTO_MAX, MEMBER_PHOTO_SIZE} from '../app/lib/member-photo-input.ts';

// HELD, review-only. Offline backup-image compressor. Local files only; it never touches a backend.
// Re-encodes the JPEG data-URL photos inside a GymEG JSON backup as WebP, downscaled to fit the slot side (320px members, aspect kept, never upscaled,
// no crop change, EXIF dropped by the re-encode), but ONLY when the result is at least --min-gain smaller (default 15%)
// AND passes the same byte validation the app uses (photo-data-url.ts) AND fits the slot cap. Anything else stays the
// original bytes. A lossy JPEG->WebP re-encode adds generation loss, so quality is explicit (default 85, the approved level).
// Dry run by default; --write OUT.json saves a copy and never overwrites the input.
// Usage: node --experimental-strip-types scripts/compress-images.mjs backup.json [--quality 85] [--min-gain 0.15] [--write out.json]
// Process-local only: lets this offline tool validate the WebP it produces. It does not change any server or client flag.
process.env.NEXT_PUBLIC_PHOTO_WEBP = '1';
const SLOTS = [
  {name: 'member photo', pick: (s) => s.members ?? [], key: 'photo', cap: MEMBER_PHOTO_MAX, side: MEMBER_PHOTO_SIZE},
  {name: 'product photo', pick: (s) => s.products ?? [], key: 'photo', cap: 90000, side: 1024},
  {name: 'club background', pick: (s) => [s.settings?.design ?? {}], key: 'backgroundImage', cap: 300000, side: 2048},
  {name: 'club member image', pick: (s) => [s.settings?.design ?? {}], key: 'memberImage', cap: 300000, side: 2048},
];
const args = process.argv.slice(2), input = args[0];
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const quality = Number(flag('--quality', '85')), minGain = Number(flag('--min-gain', '0.15')), out = flag('--write', null);
if (!input || !(quality >= 1 && quality <= 100) || !(minGain >= 0 && minGain < 1)) throw Error('Usage: node --experimental-strip-types scripts/compress-images.mjs backup.json [--quality 85] [--min-gain 0.15] [--write out.json]');
const MAX_FILE_BYTES = 256 * 1024 * 1024, MAX_ENCODED_CHARS = 4_000_000, MAX_PIXELS = 40_000_000;
if (statSync(input).size > MAX_FILE_BYTES) throw Error('refusing: input file larger than ' + MAX_FILE_BYTES + ' bytes');
const doc = JSON.parse(readFileSync(input, 'utf8'));
// Supported inputs: a v2 envelope {format:'gymos-backup', version:2, digest, state} whose digest matches, or a bare state with members[].
// Anything else (notably backup v3, whose member photos live outside the state in separate photo sections) fails closed: these
// scripts do not understand it and must not report it as processed.
if (doc && typeof doc === 'object' && 'format' in doc) {
  if (doc.format !== 'gymos-backup' || doc.version !== 2 || typeof doc.state !== 'object' || doc.state === null) throw Error('refusing: unsupported backup envelope (only v2 is supported; v3 backups keep photos outside the state)');
  if (typeof doc.digest === 'string' && doc.digest !== createHash('sha256').update(JSON.stringify(doc.state)).digest('hex')) throw Error('refusing: envelope digest does not match its state');
} else if (!Array.isArray(doc?.members) && !Array.isArray(doc?.state?.members)) throw Error('refusing: input is not a v2 backup envelope, a {state} wrapper or a state object');
const state = doc.state ?? doc;
const report = [];
for (const slot of SLOTS) for (const row of slot.pick(state)) {
  const value = row?.[slot.key];
  if (typeof value !== 'string' || photoDataUrlKind(value, Number.MAX_SAFE_INTEGER, 1 << 14) !== 'jpeg') continue;
  const entry = {slot: slot.name, id: row.id ?? slot.key, before: value.length, after: null, converted: false, reason: ''};
  try {
    if (value.length > MAX_ENCODED_CHARS) { entry.reason = 'encoded size above admission limit'; report.push(entry); continue; }
    const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
    const meta = await sharp(bytes, {limitInputPixels: MAX_PIXELS}).metadata();
    if (!meta.width || !meta.height) { entry.reason = 'unreadable size (left alone, not transcoded)'; report.push(entry); continue; }
    // Images larger than the slot side are downscaled (aspect ratio kept, EXIF orientation applied first, never upscaled).
    const buf = await sharp(bytes, {limitInputPixels: MAX_PIXELS}).rotate().resize(slot.side, slot.side, {fit: 'inside', withoutEnlargement: true}).webp({quality}).toBuffer();
    const outMeta = await sharp(buf).metadata();
    entry.dims = {before: [meta.width, meta.height, meta.orientation ?? 1], after: [outMeta.width, outMeta.height]};
    const next = 'data:image/webp;base64,' + buf.toString('base64');
    entry.after = next.length;
    if (await decodedPhotoKind(next, slot.cap, slot.side) !== 'webp') entry.reason = 'fails app validation, full decode or cap';
    else if (next.length > value.length * (1 - minGain)) entry.reason = 'gain below threshold';
    else { row[slot.key] = next; entry.converted = true; }
  } catch (e) { entry.reason = 'decode failed: ' + String(e.message).slice(0, 60); }
  report.push(entry);
}
const sum = report.reduce((a, e) => ({before: a.before + e.before, after: a.after + (e.converted ? e.after : e.before), converted: a.converted + (e.converted ? 1 : 0)}), {before: 0, after: 0, converted: 0});
console.log(JSON.stringify({images: report.length, converted: sum.converted, kept: report.length - sum.converted, beforeChars: sum.before, afterChars: sum.after, detail: report}, null, 2));
if (out) {
  validateBackup(JSON.parse(JSON.stringify(state))); // the output must pass the app's own validator before it is saved
  if (typeof doc.digest === 'string') doc.digest = createHash('sha256').update(JSON.stringify(doc.state)).digest('hex');
  writeNewFile(input, out, JSON.stringify(doc));
  console.log('Wrote ' + out);
}
