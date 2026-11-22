import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {readFileSync} from 'node:fs';
import {PHOTO_OPERATION_TYPES, restoreBudgetFor, webpOperationOk, webpStateOk, webpPhotoEntryOk, operationBudget} from '../app/lib/photo-admission.ts';

// Synthetic fixtures only.
const real = async (w = 64) => 'data:image/webp;base64,' + (await sharp({create: {width: w, height: w, channels: 3, background: '#468'}}).webp({quality: 80}).toBuffer()).toString('base64');
const fake = () => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.writeUInt32LE(22, 4); b.write('WEBPVP8 ', 8); b.writeUInt32LE(10, 16); return 'data:image/webp;base64,' + b.toString('base64'); };
const JPEG = 'data:image/jpeg;base64,/9j/AAAA';
const on = async (fn) => { process.env.NEXT_PUBLIC_PHOTO_WEBP = '1'; try { return await fn(); } finally { delete process.env.NEXT_PUBLIC_PHOTO_WEBP; } };

test('flag OFF: every entry point is a no-op', async () => {
  delete process.env.NEXT_PUBLIC_PHOTO_WEBP;
  assert.equal(await webpOperationOk({type: 'member.photo', photo: fake()}), true);
  assert.equal(await webpStateOk({members: [{photo: fake()}]}, restoreBudgetFor({members:[{}],products:[]})), true);
  assert.equal(await webpPhotoEntryOk(fake(), restoreBudgetFor({members:[{}],products:[]})), true);
});

test('typed slots only: text that merely starts with the WebP prefix is never a photo', () => on(async () => {
  const text = 'data:image/webp club';
  assert.equal(await webpOperationOk({type: 'settings.save', name: text}), true);
  assert.equal(await webpOperationOk({type: 'member.save', name: text, notes: fake(), junk: Array.from({length: 1000}, fake)}), true, 'ignored fields are not decoded');
  assert.equal(await webpStateOk({settings: {name: text}, members: [{name: text}], notes: [fake()]}, restoreBudgetFor({members:[{}],products:[]})), true);
  assert.equal(await webpOperationOk({type: 'visit.exit', junk: Array.from({length: 1000}, fake)}), true, 'an unrelated operation costs nothing');
}));

test('slots: real WebP passes, fabricated and truncated fail, JPEG and null untouched, per-slot char cap', () => on(async () => {
  const good = await real();
  assert.equal(await webpOperationOk({type: 'member.photo', photo: good}), true);
  assert.equal(await webpOperationOk({type: 'member.photo', photo: fake()}), false);
  assert.equal(await webpOperationOk({type: 'member.photo', photo: good.slice(0, good.length - 40)}), false);
  assert.equal(await webpOperationOk({type: 'member.photo', photo: JPEG}), true);
  assert.equal(await webpOperationOk({type: 'member.photo', photo: null}), true);
  assert.equal(await webpOperationOk({type: 'shop.product.save', photo: good}), true);
  assert.equal(await webpOperationOk({type: 'design.save', design: {backgroundImage: good, memberImage: fake()}}), false);
  assert.equal(await webpOperationOk({type: 'member.photo', photo: 'data:image/webp;base64,' + 'A'.repeat(96_000)}), false, 'over the member cap: rejected by length before any decode');
  assert.equal(await webpStateOk({members: [{photo: good}], products: [{photo: good}], settings: {design: {memberImage: good}}}, restoreBudgetFor({members:[{}],products:[]})), true);
  assert.equal(await webpStateOk({members: [{photo: good}, {photo: fake()}]}, restoreBudgetFor({members:[{}],products:[]})), false);
  assert.equal(await webpStateOk({settings: {design: {backgroundImage: fake()}}}, restoreBudgetFor({members:[{}],products:[]})), false);
}));

test('work budget: identical values decode once; one shared budget spans the core and all pages; exhaustion fails closed', () => on(async () => {
  const good = await real(), members = Array.from({length: 1000}, () => ({photo: good}));
  const b = restoreBudgetFor({members});
  const start = b.decodes;
  assert.equal(await webpStateOk({members}, b), true);
  assert.equal(start - b.decodes, 1, '1000 identical slots = ONE decode');
  assert.equal(await webpPhotoEntryOk(good, b), true);
  assert.equal(start - b.decodes, 1, 'shared budget and dedup across v3 entries');
  const distinct = await Promise.all([20, 21, 22, 23].map((w) => real(w)));
  assert.equal(await webpStateOk({members: distinct.map((photo) => ({photo}))}, operationBudget()), false, 'a 4th distinct decode exceeds the per-operation budget');
  assert.equal(await webpStateOk({members: distinct.slice(0, 3).map((photo) => ({photo}))}, {decodes: 2, pixels: 1e9, seen: new Set()}), false);
  assert.equal(await webpStateOk({members: Array.from({length: 50_001}, () => ({}))}, restoreBudgetFor({})), false, 'row count bound');
  // v3 portraits are charged against the core's member count: more distinct portraits than members is out of budget.
  const small = restoreBudgetFor({members: [{}]});
  assert.equal(await webpPhotoEntryOk(distinct[0], small), true);
  assert.equal(await webpPhotoEntryOk(distinct[1], small), true, 'budget is members+products+2 decodes');
  assert.equal(await webpPhotoEntryOk(distinct[2], small), true);
  assert.equal(await webpPhotoEntryOk(distinct[3], small), false);
}));

test('wiring regression (source order; behaviour is proven by the real-route and v3 integration tests)', () => {
  const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const ws = src('app/api/workspace/route.ts');
  assert.ok(ws.indexOf('webpOperationOk(body.operation,') > ws.indexOf("'demo.clear'") && ws.indexOf('webpOperationOk(body.operation,') < ws.indexOf('applyOperation('), 'after role/branch checks, before apply');
  const bk = src('app/api/backup/route.ts');
  assert.ok(bk.indexOf('validateBackup(backup.state)') < bk.indexOf('webpStateOk(state,'), 'v2: schema and cardinality validation first, then decode');
  const v3 = src('app/lib/backup-v3.ts');
  assert.ok(v3.indexOf('await prevalidateWebpSections(') < v3.indexOf("await client.query('BEGIN')"), 'v3 decode happens before the restore transaction opens');
  const body = v3.slice(v3.indexOf('async function prevalidateWebpSections'), v3.indexOf('export async function commitRestoreV3('));
  assert.ok(body.indexOf('validateBackup(') < body.indexOf('webpStateOk('), 'v3: cheap validation before any decode');
});

test('guard: every operation case in domain.ts/shop.ts that handles a photo or design image is in the decode gate list', () => {
  const found = new Set();
  for (const f of ['app/lib/domain.ts', 'app/lib/shop.ts']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const cases = [...src.matchAll(/case\s*['"]([a-zA-Z0-9_.]+)['"]\s*:/g)];
    cases.forEach((m, i) => { const seg = src.slice(m.index + m[0].length, cases[i + 1]?.index ?? m.index + 3000); if (/op\.photo|op\.design|backgroundImage|memberImage/.test(seg)) found.add(m[1]); });
  }
  assert.ok(found.size >= 5, 'scan sanity: ' + [...found]);
  assert.deepEqual([...found].filter((t) => !PHOTO_OPERATION_TYPES.includes(t)), []);
});

test('restore budget is derived from the content, not a constant', () => {
  const b = restoreBudgetFor({members: Array.from({length: 10}, () => ({})), products: [{}]});
  assert.equal(b.decodes, 13); assert.equal(b.pixels, 10 * 320 * 320 + 1024 * 1024 + 2 * 2048 * 2048);
  assert.equal(restoreBudgetFor({}).decodes, 2);
});

import {withDecodeGate, DecodeBusy, decodeLimits, decodeGateStats} from '../app/lib/photo-admission.ts';
test('decode gate: bounded queue, wait timeout drops the waiter, work deadline stops decoding, failure does not poison', async () => {
  const saved = {...decodeLimits};
  try {
    decodeLimits.maxWaiting = 1; decodeLimits.waitMs = 40;
    let release; const hold = new Promise(r => { release = r; });
    const running = withDecodeGate(async () => { await hold; return 'a'; });
    const waiter = withDecodeGate(async () => 'b');
    await assert.rejects(() => withDecodeGate(async () => 'c'), e => e instanceof DecodeBusy && e.reason === 'queue');
    await assert.rejects(waiter, e => e instanceof DecodeBusy && e.reason === 'wait');
    assert.equal(decodeGateStats().waiting, 0, 'timed-out waiter is removed from the queue');
    release(); assert.equal(await running, 'a');
    assert.deepEqual(decodeGateStats(), {running: false, waiting: 0});
    // waiter that is admitted in time runs after the holder
    decodeLimits.waitMs = 1000;
    let rel2; const h2 = new Promise(r => { rel2 = r; });
    const r1 = withDecodeGate(async () => { await h2; return 1; });
    const r2 = withDecodeGate(async () => 2);
    rel2(); assert.deepEqual([await r1, await r2], [1, 2]);
    // work deadline: a restore-size job past its deadline stops before the next decode
    decodeLimits.workMs = 1;
    const img = await real(32);
    await on(async () => assert.rejects(() => withDecodeGate(async d => { await new Promise(r => setTimeout(r, 15)); return webpStateOk({members: [{photo: img}]}, restoreBudgetFor({members: [1]}, d)); }), e => e instanceof DecodeBusy && e.reason === 'deadline'));
    await assert.rejects(() => withDecodeGate(async () => { throw Error('boom'); }));
    assert.equal(await withDecodeGate(async () => 'ok'), 'ok');
    assert.deepEqual(decodeGateStats(), {running: false, waiting: 0});
  } finally { Object.assign(decodeLimits, saved); }
});

test('decode gate: abort removes a queued waiter, aborted/late work never returns a result', async () => {
  const saved = {...decodeLimits};
  try {
    decodeLimits.waitMs = 5000; decodeLimits.maxWaiting = 2;
    let release; const hold = new Promise(r => { release = r; });
    const running = withDecodeGate(async () => { await hold; return 'a'; });
    const ac = new AbortController(); let ran = false;
    const queued = withDecodeGate(async () => { ran = true; return 'q'; }, ac.signal);
    assert.equal(decodeGateStats().waiting, 1);
    ac.abort();
    await assert.rejects(queued, e => e instanceof DecodeBusy && e.reason === 'aborted');
    assert.equal(decodeGateStats().waiting, 0); release(); await running; assert.equal(ran, false);
    // abort DURING work: result discarded
    const ac2 = new AbortController();
    await assert.rejects(withDecodeGate(async () => { ac2.abort(); return 'late'; }, ac2.signal), e => e.reason === 'aborted');
    // already aborted: never starts
    await assert.rejects(withDecodeGate(async () => { ran = true; }, ac2.signal), e => e.reason === 'aborted');
    // deadline passes during the LAST await: no result
    decodeLimits.workMs = 5;
    await assert.rejects(withDecodeGate(async () => { await new Promise(r => setTimeout(r, 30)); return 'late'; }), e => e.reason === 'deadline');
    assert.deepEqual(decodeGateStats(), {running: false, waiting: 0});
  } finally { Object.assign(decodeLimits, saved); }
});
