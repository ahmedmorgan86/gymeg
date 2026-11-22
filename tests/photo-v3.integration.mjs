import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {validPhotoEntry} from '../app/lib/backup-v3.ts';
// Synthetic fixtures only. Backup v3 photo pages use the same predicate as v2 and domain (photo-data-url.ts).
const webp = 'data:image/webp;base64,' + (await sharp({create: {width: 320, height: 320, channels: 3, background: '#468'}}).webp({quality: 85}).toBuffer()).toString('base64');
const jpeg = 'data:image/jpeg;base64,' + (await sharp({create: {width: 32, height: 32, channels: 3, background: '#468'}}).jpeg().toBuffer()).toString('base64');
test('v3 photo entries: flag OFF is JPEG-only like legacy, flag ON accepts real WebP, fakes always rejected', () => {
  delete process.env.NEXT_PUBLIC_PHOTO_WEBP;
  assert.equal(validPhotoEntry('m1', jpeg), true);
  assert.equal(validPhotoEntry('m1', webp), false);
  process.env.NEXT_PUBLIC_PHOTO_WEBP = '1';
  try {
    assert.equal(validPhotoEntry('m1', webp), true);
    assert.equal(validPhotoEntry('m1', jpeg), true);
    assert.equal(validPhotoEntry('m1', 'data:image/webp;base64,UklGR' + 'A'.repeat(500)), false);
    assert.equal(validPhotoEntry('', jpeg), false);
    assert.equal(validPhotoEntry('x'.repeat(251), jpeg), false);
  } finally { delete process.env.NEXT_PUBLIC_PHOTO_WEBP; }
});
