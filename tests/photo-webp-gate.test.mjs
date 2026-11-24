import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {photoDataUrlKind} from '../app/lib/photo-data-url.ts';
import {decodedPhotoKind} from '../app/lib/photo-decode.ts';
import {applyOperation, emptyState} from '../app/lib/domain.ts';
import {validateBackup} from '../app/lib/backup.ts';
import {clubDesignSchema, defaultClubDesign} from '../app/lib/club-design.ts';

// Synthetic fixtures only.
async function realWebp(w = 320, h = 320) {
  const buf = Buffer.alloc(w * h * 3); let s = 9;
  for (let i = 0; i < buf.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; buf[i] = ((i / 3 % w) * 255 / w + (s % 40)) & 255; }
  return await sharp(buf, {raw: {width: w, height: h, channels: 3}}).webp({quality: 85}).toBuffer();
}
const durl = (b) => 'data:image/webp;base64,' + b.toString('base64');
const op = (photo) => ({type: 'member.save', branch: 'main', name: 'S', phone: '', joined: '2026-10-01', expires: '2026-12-01', photo});
const NOW = '2026-11-22T10:00:00Z';
const JPEG = 'data:image/jpeg;base64,' + (await sharp({create: {width: 32, height: 32, channels: 3, background: '#468'}}).jpeg().toBuffer()).toString('base64');

test('flag OFF (default): WebP is rejected by EVERY validator, JPEG unchanged', async () => {
  delete process.env.NEXT_PUBLIC_PHOTO_WEBP;
  const w = durl(await realWebp());
  assert.equal(photoDataUrlKind(w, 96000, 320), null);
  assert.throws(() => applyOperation(emptyState(), op(w), NOW, 'T', randomUUID));
  assert.equal(applyOperation(emptyState(), op(JPEG), NOW, 'T', randomUUID).members[0].photo, JPEG);
  const st = applyOperation(emptyState(), op(), NOW, 'T', randomUUID); st.members[0].photo = w;
  assert.throws(() => validateBackup(JSON.parse(JSON.stringify(st))));
  assert.ok(!clubDesignSchema.safeParse({...defaultClubDesign(), backgroundImage: w}).success);
});
test('lossless WebP with alpha (VP8L) is refused by the header check and by decode (policy: no alpha)', async () => {
  process.env.NEXT_PUBLIC_PHOTO_WEBP = '1';
  try {
    const a = await sharp({create: {width: 320, height: 320, channels: 4, background: {r: 9, g: 9, b: 9, alpha: 0.5}}}).webp({lossless: true}).toBuffer();
    assert.equal(a.subarray(12, 16).toString(), 'VP8L', 'fixture is VP8L, not VP8X');
    assert.equal(photoDataUrlKind(durl(a), 96000, 320), null);
    assert.equal(await decodedPhotoKind(durl(a), 96000, 320), null);
    const opaque = await sharp({create: {width: 320, height: 320, channels: 3, background: '#468'}}).webp({lossless: true}).toBuffer();
    assert.equal(await decodedPhotoKind(durl(opaque), 96000, 320), 'webp', 'opaque lossless stays accepted');
  } finally { delete process.env.NEXT_PUBLIC_PHOTO_WEBP; }
});
test('structural check is NOT a decode: a fabricated 30-byte VP8 header passes it and fails full decode', async () => {
  process.env.NEXT_PUBLIC_PHOTO_WEBP = '1';
  try {
    const fake = Buffer.alloc(30); fake.write('RIFF', 0); fake.writeUInt32LE(22, 4); fake.write('WEBPVP8 ', 8); fake.writeUInt32LE(10, 16);
    fake[20] = 0x10; fake[23] = 0x9d; fake[24] = 0x01; fake[25] = 0x2a; fake.writeUInt16LE(1, 26); fake.writeUInt16LE(1, 28);
    const f = durl(fake);
    assert.equal(photoDataUrlKind(f, 96000, 320), 'webp', 'documents the known limitation of the header check');
    assert.equal(await decodedPhotoKind(f, 96000, 320), null, 'full decode rejects it');
    const real = await realWebp(), cut = Buffer.from(real.subarray(0, 200)); // truncated bitstream, container sizes rewritten to stay consistent
    cut.writeUInt32LE(cut.length - 8, 4); cut.writeUInt32LE(cut.length - 20, 16);
    assert.equal(photoDataUrlKind(durl(cut), 96000, 320), 'webp', 'passes the structural check');
    assert.equal(await decodedPhotoKind(durl(cut), 96000, 320), null, 'corrupt bitstream with valid header rejected by decode');
    assert.equal(await decodedPhotoKind(durl(real), 96000, 320), 'webp');
    assert.equal(await decodedPhotoKind(JPEG, 96000, 320), 'jpeg');
    assert.equal(await decodedPhotoKind('data:image/webp;base64,xx', 96000, 320), null);
  } finally { delete process.env.NEXT_PUBLIC_PHOTO_WEBP; }
});
const run = (script, args) => { try { execFileSync('node', ['--experimental-strip-types', script, ...args], {stdio: ['ignore', 'pipe', 'pipe']}); return 0; } catch (e) { return e.status ?? 1; } };
for (const script of ['scripts/compress-images.mjs', 'scripts/reduce-demo.mjs']) {
  test(`${script}: never overwrites or aliases the input, never overwrites an existing output`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-')), f = join(dir, 'b.json');
    const body = JSON.stringify({digest: 'x', state: {members: [], products: [], settings: {design: {}}}});
    writeFileSync(f, body);
    assert.notEqual(run(script, [f, '--write', f]), 0, 'same path');
    mkdirSync(join(dir, 'd')); symlinkSync(f, join(dir, 'alias.json'));
    assert.notEqual(run(script, [f, '--write', join(dir, 'alias.json')]), 0, 'symlink alias of the input');
    symlinkSync(dir, join(dir, 'dirlink')); // output reaches the input through a symlinked directory
    assert.notEqual(run(script, [f, '--write', join(dir, 'dirlink', 'b.json')]), 0, 'path through a symlinked directory');
    symlinkSync(join(dir, 'nowhere.json'), join(dir, 'dangling.json'));
    assert.notEqual(run(script, [f, '--write', join(dir, 'dangling.json')]), 0, 'dangling symlink');
    assert.equal(existsSync(join(dir, 'nowhere.json')), false, 'nothing created through the dangling link');
    writeFileSync(join(dir, 'existing.json'), 'KEEP');
    assert.notEqual(run(script, [f, '--write', join(dir, 'existing.json')]), 0, 'existing output');
    assert.equal(readFileSync(join(dir, 'existing.json'), 'utf8'), 'KEEP');
    assert.equal(readFileSync(f, 'utf8'), body, 'input untouched after every refusal');
  });
}
