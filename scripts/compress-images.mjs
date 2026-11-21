import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';

// Offline backup-image compressor: re-encodes the base64 data-URL photos
// embedded in a GymEG JSON backup as WebP, keeping the same geometry and
// byte caps the upload path enforces. Reads and writes local files only;
// it never touches a backend. Dry-run by default; pass --write OUT.json to
// save the converted backup.
//
// Usage: node scripts/compress-images.mjs backup.json [--write out.json]

const SLOTS = [
  {name: 'member photo', pick: (s) => s.members ?? [], key: 'photo', width: 160, height: 160, fit: 'cover', cap: 22000},
  {name: 'product photo', pick: (s) => s.products ?? [], key: 'photo', width: 480, height: 480, fit: 'inside', cap: 90000},
  {name: 'club background', pick: (s) => [s.settings?.design ?? {}], key: 'backgroundImage', width: 1400, height: 1400, fit: 'inside', cap: 300000},
  {name: 'club member image', pick: (s) => [s.settings?.design ?? {}], key: 'memberImage', width: 1400, height: 1400, fit: 'inside', cap: 300000},
];
const QUALITIES = [0.8, 0.65, 0.5, 0.35];
const JPEG = /^data:image\/jpeg;base64,/;

async function reencode(dataUrl, slot) {
  const input = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  let pipeline = sharp(input).rotate();
  if (slot.fit === 'cover') pipeline = pipeline.resize(slot.width, slot.height, {fit: 'cover'});
  else pipeline = pipeline.resize(slot.width, slot.height, {fit: 'inside', withoutEnlargement: true});
  for (const quality of QUALITIES) {
    const buffer = await pipeline.clone().webp({quality: Math.round(quality * 100)}).toBuffer();
    const value = 'data:image/webp;base64,' + buffer.toString('base64');
    if (value.length <= slot.cap) return value;
  }
  return null;
}

const input = process.argv[2], outIndex = process.argv.indexOf('--write');
if (!input) throw Error('Usage: node scripts/compress-images.mjs backup.json [--write out.json]');
const doc = JSON.parse(readFileSync(input, 'utf8'));
const state = doc.state ?? doc;
const report = [];
for (const slot of SLOTS) {
  for (const row of slot.pick(state)) {
    const value = row?.[slot.key];
    if (typeof value !== 'string' || !JPEG.test(value)) continue;
    const converted = await reencode(value, slot);
    const entry = {slot: slot.name, id: row.id ?? slot.key, before: value.length, after: converted?.length ?? null, converted: Boolean(converted && converted.length < value.length)};
    if (converted && converted.length < value.length) row[slot.key] = converted;
    report.push(entry);
  }
}
const totals = report.reduce((a, e) => ({before: a.before + e.before, after: a.after + (e.converted ? e.after : e.before), converted: a.converted + (e.converted ? 1 : 0)}), {before: 0, after: 0, converted: 0});
console.log(JSON.stringify({images: report.length, converted: totals.converted, beforeChars: totals.before, afterChars: totals.after, savedChars: totals.before - totals.after, detail: report}, null, 2));
if (outIndex > 0) {
  const out = process.argv[outIndex + 1];
  if (!out) throw Error('--write needs an output path');
  if (doc && typeof doc.digest === 'string') doc.digest = createHash('sha256').update(JSON.stringify(doc.state)).digest('hex');
  writeFileSync(out, JSON.stringify(doc));
  console.log('Wrote ' + out);
}
