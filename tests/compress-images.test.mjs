import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createHash, randomUUID} from 'node:crypto';
import {applyOperation, emptyState} from '../app/lib/domain.ts';
import {photoDataUrlKind} from '../app/lib/photo-data-url.ts';
process.env.NEXT_PUBLIC_PHOTO_WEBP = '1';
// Synthetic fixtures only.
async function img(w, h, q) {
  const buf = Buffer.alloc(w * h * 3); let s = 3;
  for (let i = 0; i < buf.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; buf[i] = ((i / 3 % w) * 255 / w + (s % 30)) & 255; }
  return 'data:image/jpeg;base64,' + (await sharp(buf, {raw: {width: w, height: h, channels: 3}}).jpeg({quality: q}).toBuffer()).toString('base64');
}
const envelope = (photos) => {
  let state = emptyState();
  photos.forEach((photo, i) => { state = applyOperation(state, {type: 'member.save', branch: 'main', name: 'Synthetic ' + i, phone: '', joined: '2026-10-01', expires: '2026-12-01', ...(photo ? {photo} : {})}, '2026-11-22T10:00:00Z', 'T', randomUUID); });
  return {format: 'gymos-backup', version: 2, tenant: 't', digest: createHash('sha256').update(JSON.stringify(state)).digest('hex'), state};
};
const exec = (f, ...a) => { try { return {status: 0, out: execFileSync('node', ['--experimental-strip-types', 'scripts/compress-images.mjs', f, ...a], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})}; } catch (e) { return {status: e.status, out: String(e.stdout) + String(e.stderr)}; } };
test('compress-images: converts only when valid and smaller, keeps others byte-identical, output passes the app validator and a fresh digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-')), f = join(dir, 'b.json'), o = join(dir, 'o.json');
  const big = await img(320, 320, 90), tiny = await img(16, 16, 50), over = await img(400, 400, 95);
  const doc = envelope([big, tiny, null, null]); doc.state.members[3].photo = over; doc.digest = createHash('sha256').update(JSON.stringify(doc.state)).digest('hex'); writeFileSync(f, JSON.stringify(doc));
  const before = readFileSync(f, 'utf8');
  const dry = JSON.parse(exec(f).out);
  assert.equal(readFileSync(f, 'utf8'), before, 'dry run does not write');
  assert.equal(dry.images, 3);
  const by = Object.fromEntries(dry.detail.map((e) => [e.before, e]));
  assert.equal(by[big.length].converted, true);
  assert.ok(by[big.length].after < big.length * 0.85);
  assert.equal(by[over.length].converted, true, 'oversized side is downscaled: ' + JSON.stringify(by[over.length]));
  assert.deepEqual(by[over.length].dims.after, [320, 320]);
  for (const e of dry.detail) if (e.converted) assert.ok(e.after <= e.before * 0.85);
  assert.equal(JSON.parse(exec(f, '--min-gain', '0.99').out).converted, 0);
  assert.equal(exec(f, '--write', o).status, 0);
  const w = JSON.parse(readFileSync(o, 'utf8'));
  assert.equal(photoDataUrlKind(w.state.members[0].photo, 96000, 320), 'webp');
  assert.equal(photoDataUrlKind(w.state.members[3].photo, 96000, 320), 'webp');
  assert.equal(w.state.members[2].photo, undefined);
  assert.equal(w.digest, createHash('sha256').update(JSON.stringify(w.state)).digest('hex'));
  assert.equal(readFileSync(f, 'utf8'), before, 'input byte-identical after the write');
});
test('compress-images: unsupported or inconsistent inputs fail closed and write nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-')), o = join(dir, 'o.json');
  const cases = {
    v3: {format: 'gymos-backup', version: 3, sessionId: 'x'},
    v9: {format: 'gymos-backup', version: 9, state: {}},
    nonsense: {hello: 1},
    tampered: (() => { const d = envelope([null]); d.state.members[0].name = 'Tampered'; return d; })(),
  };
  for (const [name, doc] of Object.entries(cases)) {
    const f = join(dir, name + '.json'); writeFileSync(f, JSON.stringify(doc));
    const r = exec(f, '--write', o);
    assert.notEqual(r.status, 0, name);
    assert.equal(existsSync(o), false, name + ' wrote nothing');
  }
});

test('compress-images: downscales above-target photos with aspect ratio and EXIF orientation preserved, never upscales', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-')), f = join(dir, 'b.json'), o = join(dir, 'o.json');
  const raw = async (w, h, orient) => { const buf = Buffer.alloc(w * h * 3); let s = 7; for (let i = 0; i < buf.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; buf[i] = ((i / 3 % w) * 255 / w + (s % 40)) & 255; } let p = sharp(buf, {raw: {width: w, height: h, channels: 3}}); if (orient) p = p.withMetadata({orientation: orient}); return 'data:image/jpeg;base64,' + (await p.jpeg({quality: 92}).toBuffer()).toString('base64'); };
  const land = await raw(1280, 640), rot = await raw(900, 450, 6), small = await raw(200, 100);
  const doc = envelope([null, null, null]); [land, rot, small].forEach((u, i) => { doc.state.members[i].photo = u; }); doc.digest = createHash('sha256').update(JSON.stringify(doc.state)).digest('hex');
  writeFileSync(f, JSON.stringify(doc));
  assert.equal(exec(f, '--write', o).status, 0);
  const w = JSON.parse(readFileSync(o, 'utf8'));
  const dim = async (u) => { const m = await sharp(Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')).metadata(); return [m.width, m.height]; };
  assert.deepEqual(await dim(w.state.members[0].photo), [320, 160]);
  assert.deepEqual(await dim(w.state.members[1].photo), [160, 320], 'orientation 6 landscape becomes upright portrait');
  assert.ok((await dim(w.state.members[2].photo))[0] <= 200, 'never upscaled');
  for (const m of w.state.members) assert.equal(photoDataUrlKind(m.photo, 96000, 320), 'webp');
  assert.equal(w.digest, createHash('sha256').update(JSON.stringify(w.state)).digest('hex'));
});
