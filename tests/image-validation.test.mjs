import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {applyOperation, emptyState} from '../app/lib/domain.ts';
import {validateBackup} from '../app/lib/backup.ts';
import {productSchema} from '../app/lib/shop.ts';
import {clubDesignSchema, defaultClubDesign, validClubDesign} from '../app/lib/club-design.ts';

async function dataUrl(mime, width, height, quality = 80) {
  const pixel = sharp({create: {width, height, channels: 3, background: {r: 120, g: 60, b: 30}}});
  const buffer = mime === 'image/webp' ? await pixel.webp({quality}).toBuffer() : await pixel.jpeg({quality}).toBuffer();
  return `data:${mime};base64,` + buffer.toString('base64');
}

const NOW = '2026-10-18T12:00:00Z';
const saveOp = (photo) => ({type: 'member.save', branch: 'main', name: 'Synthetic test only', phone: '', joined: '2026-10-01', expires: '2026-11-01', photo});

test('member.save accepts WebP and JPEG photos and rejects other data URLs', async () => {
  const webp = await dataUrl('image/webp', 160, 160);
  const jpeg = await dataUrl('image/jpeg', 160, 160);
  assert.ok(webp.length <= 22000 && jpeg.length <= 22000);
  assert.equal(applyOperation(emptyState(), saveOp(webp), NOW, 'Test', randomUUID).members[0].photo, webp);
  assert.equal(applyOperation(emptyState(), saveOp(jpeg), NOW, 'Test', randomUUID).members[0].photo, jpeg);
  assert.throws(() => applyOperation(emptyState(), saveOp('data:image/png;base64,iVBORw0KGgo='), NOW, 'Test', randomUUID));
  assert.throws(() => applyOperation(emptyState(), saveOp('data:image/webp;base64,AAAA'), NOW, 'Test', randomUUID));
  assert.throws(() => applyOperation(emptyState(), saveOp('data:image/webp;base64,UklGR' + 'A'.repeat(22000)), NOW, 'Test', randomUUID));
});

test('member.photo accepts WebP photos and clears them on null', async () => {
  const webp = await dataUrl('image/webp', 160, 160);
  let state = applyOperation(emptyState(), saveOp(undefined), NOW, 'Test', randomUUID);
  const id = state.members[0].id;
  state = applyOperation(state, {type: 'member.photo', branch: 'main', id, photo: webp}, NOW, 'Test', randomUUID);
  assert.equal(state.members[0].photo, webp);
  state = applyOperation(state, {type: 'member.photo', branch: 'main', id, photo: null}, NOW, 'Test', randomUUID);
  assert.equal(state.members[0].photo, undefined);
  assert.throws(() => applyOperation(state, {type: 'member.photo', branch: 'main', id, photo: 'data:image/png;base64,iVBORw0KGgo='}, NOW, 'Test', randomUUID));
});

test('backup validation round-trips WebP member photos', async () => {
  const webp = await dataUrl('image/webp', 160, 160);
  const state = applyOperation(emptyState(), saveOp(webp), NOW, 'Test', randomUUID);
  const restored = validateBackup(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.members[0].photo, webp);
});

test('product and club design images accept WebP within their byte caps', async () => {
  const productWebp = await dataUrl('image/webp', 480, 480);
  assert.ok(productWebp.length <= 90000);
  const product = {id: 'p1', branch: 'main', name: 'Synthetic', sku: 'S1', photo: productWebp, category: 'other', price: 100, lowStock: 0, archived: false};
  assert.equal(productSchema.parse(product).photo, productWebp);
  const designWebp = await dataUrl('image/webp', 1400, 900);
  assert.ok(designWebp.length <= 300000);
  const design = {...defaultClubDesign(), backgroundImage: designWebp};
  assert.equal(clubDesignSchema.parse(design).backgroundImage, designWebp);
  assert.equal(validClubDesign(design), true);
  assert.throws(() => productSchema.parse({...product, photo: 'data:image/webp;base64,AAAA'}));
});
