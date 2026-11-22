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
  const big = await img(320, 320, 90), tiny = await img(16, 16, 50), over = await img(400, 400, 30);
  const doc = envelope([big, tiny, null, over]); writeFileSync(f, JSON.stringify(doc));
  const before = readFileSync(f, 'utf8');
  const dry = JSON.parse(exec(f).out);
  assert.equal(readFileSync(f, 'utf8'), before, 'dry run does not write');
  assert.equal(dry.images, 3);
  const by = Object.fromEntries(dry.detail.map((e) => [e.before, e]));
  assert.equal(by[big.length].converted, true);
  assert.ok(by[big.length].after < big.length * 0.85);
  assert.equal(by[over.length].converted, false, 'oversized side is left alone, not transcoded');
  for (const e of dry.detail) if (e.converted) assert.ok(e.after <= e.before * 0.85);
  assert.equal(JSON.parse(exec(f, '--min-gain', '0.99').out).converted, 0);
  assert.equal(exec(f, '--write', o).status, 0);
  const w = JSON.parse(readFileSync(o, 'utf8'));
  assert.equal(photoDataUrlKind(w.state.members[0].photo, 96000, 320), 'webp');
  assert.equal(w.state.members[3].photo, over);
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
