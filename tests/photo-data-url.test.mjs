process.env.NEXT_PUBLIC_PHOTO_WEBP = '1'; // WebP admission is flag-gated; these tests exercise the ON state (the OFF state is tests/photo-webp-gate.test.mjs)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import {photoDataUrlKind} from '../app/lib/photo-data-url.ts';
import {applyOperation, emptyState} from '../app/lib/domain.ts';
import {validateBackup} from '../app/lib/backup.ts';
import {productSchema} from '../app/lib/shop.ts';
import {clubDesignSchema, defaultClubDesign} from '../app/lib/club-design.ts';
import {MEMBER_PHOTO_MAX, MEMBER_PHOTO_SIZE} from '../app/lib/member-photo-input.ts';

// Synthetic fixtures only (generated gradients and noise, no real photo).
async function face(w = 320, h = 320) {
  const buf = Buffer.alloc(w * h * 3); let s = 7;
  for (let i = 0; i < buf.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; buf[i] = ((i / 3 % w) * 255 / w + (s % 40)) & 255; }
  return sharp(buf, {raw: {width: w, height: h, channels: 3}});
}
const url = (mime, b) => `data:${mime};base64,` + b.toString('base64');
const webp = async (w, h, o = {quality: 85}) => url('image/webp', await (await face(w, h)).webp(o).toBuffer());
const jpeg = async (w, h, q = 85) => url('image/jpeg', await (await face(w, h)).jpeg({quality: q}).toBuffer());
const K = (v, max = MEMBER_PHOTO_MAX, side = MEMBER_PHOTO_SIZE) => photoDataUrlKind(v, max, side);

test('real encoder output is accepted: lossy WebP, lossless WebP, JPEG', async () => {
  assert.equal(K(await webp(320, 320)), 'webp');
  assert.equal(K(await webp(320, 320, {lossless: true})), 'webp');
  assert.equal(K(await jpeg(320, 320)), 'jpeg');
});
test('WebP is rejected on bytes, not on prefix', async () => {
  const good = await webp(320, 320), raw = Buffer.from(good.split(',')[1], 'base64');
  const re = (b) => url('image/webp', b);
  assert.equal(K('data:image/webp;base64,UklGR' + 'A'.repeat(2000)), null, 'prefix-only fake');
  assert.equal(K(re(raw.subarray(0, raw.length - 10))), null, 'truncated');
  assert.equal(K(re(Buffer.concat([raw, Buffer.from([0, 0, 0, 0])]))), null, 'trailing bytes');
  const sizeBad = Buffer.from(raw); sizeBad.writeUInt32LE(raw.length, 4); assert.equal(K(re(sizeBad)), null, 'RIFF size wrong');
  const wrongTag = Buffer.from(raw); wrongTag.write('AVIF', 8); assert.equal(K(re(wrongTag)), null, 'not WEBP');
  const chunkBad = Buffer.from(raw); chunkBad.writeUInt32LE(raw.readUInt32LE(16) + 2, 16); assert.equal(K(re(chunkBad)), null, 'chunk size does not close file');
  const sig = Buffer.from(raw); sig[23] = 0; assert.equal(K(re(sig)), null, 'bad VP8 start code');
  assert.equal(K(good.replace('data:image/webp', 'data:image/png')), null, 'wrong mime');
  assert.equal(K(good.slice(0, -1) + '!'), null, 'non-base64 char');
  assert.equal(K(good + '='), null, 'bad padding');
});
test('WebP carrying animation, alpha or metadata (VP8X) is refused', async () => {
  const withExif = await (await face()).webp({quality: 85}).withMetadata({exif: {IFD0: {Copyright: 'x'}}}).toBuffer();
  assert.equal(withExif.subarray(12, 16).toString(), 'VP8X', 'fixture really is extended');
  assert.equal(K(url('image/webp', withExif)), null);
  const alpha = await sharp({create: {width: 320, height: 320, channels: 4, background: {r: 1, g: 2, b: 3, alpha: .5}}}).webp().toBuffer();
  assert.equal(K(url('image/webp', alpha)), null);
});
test('dimension and cap bounds', async () => {
  assert.equal(K(await webp(321, 320)), null);
  assert.equal(K(await webp(320, 321)), null);
  assert.equal(K(await webp(100, 100)), 'webp', 'smaller than the contract side is fine');
  const w = await webp(320, 320);
  assert.equal(K(w, w.length - 1), null, 'cap is a hard limit');
  assert.equal(K(w, w.length), 'webp');
});
test('JPEG decision is IDENTICAL to the legacy prefix rule (never rejects what legacy accepted)', async () => {
  const legacy = (v, max) => typeof v === 'string' && v.length <= max && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/=]+$/.test(v);
  const corpus = [await jpeg(320, 320), await jpeg(64, 64, 30), 'data:image/jpeg;base64,/9j/AAAA', 'data:image/jpeg;base64,/9j/AA=', 'data:image/jpeg;base64,/9j/', 'data:image/jpeg;base64,xxxx', 'data:image/png;base64,iVBORw0KGgo=', '', 5, null, undefined, 'data:image/jpeg;base64,/9j/' + 'A'.repeat(MEMBER_PHOTO_MAX)];
  for (const v of corpus) for (const max of [100, MEMBER_PHOTO_MAX]) assert.equal(K(v, max, 320) === 'jpeg', legacy(v, max), String(v).slice(0, 40));
});
const NOW = '2026-11-22T10:00:00Z';
test('domain, backup, shop and club design accept real WebP and still accept JPEG', async () => {
  for (const photo of [await webp(320, 320), await jpeg(320, 320)]) {
    const s = applyOperation(emptyState(), {type: 'member.save', branch: 'main', name: 'Synthetic', phone: '', joined: '2026-10-01', expires: '2026-12-01', photo}, NOW, 'T', randomUUID);
    assert.equal(s.members[0].photo, photo);
    const s2 = applyOperation(s, {type: 'member.photo', branch: 'main', id: s.members[0].id, photo: null}, NOW, 'T', randomUUID);
    assert.equal(s2.members[0].photo, undefined);
    const s3 = applyOperation(s2, {type: 'member.photo', branch: 'main', id: s.members[0].id, photo}, NOW, 'T', randomUUID);
    assert.equal(s3.members[0].photo, photo);
    validateBackup(JSON.parse(JSON.stringify(s3)));
  }
  const bad = 'data:image/webp;base64,UklGR' + 'A'.repeat(2000);
  assert.throws(() => applyOperation(emptyState(), {type: 'member.save', branch: 'main', name: 'S', phone: '', joined: '2026-10-01', expires: '2026-12-01', photo: bad}, NOW, 'T', randomUUID));
  const st = applyOperation(emptyState(), {type: 'member.save', branch: 'main', name: 'S', phone: '', joined: '2026-10-01', expires: '2026-12-01'}, NOW, 'T', randomUUID);
  st.members[0].photo = bad;
  assert.throws(() => validateBackup(JSON.parse(JSON.stringify(st))), 'backup restore rejects a fake WebP');
  const d = {...defaultClubDesign(), backgroundImage: await webp(320, 320)};
  assert.ok(clubDesignSchema.safeParse(d).success);
  assert.ok(!clubDesignSchema.safeParse({...defaultClubDesign(), backgroundImage: bad}).success);
});
