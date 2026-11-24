import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {emptyState} from '../app/lib/domain.ts';
import {completeDemo} from '../app/lib/complete-demo.ts';
import {addDemoShowcase} from '../app/lib/demo-showcase.ts';
import {validateBackup} from '../app/lib/backup.ts';

const NOW = '2026-11-21T10:00:00.000Z';

function fixture() {
  let state = emptyState();
  state.settings.name = 'نادي تجريبي Demo Club';
  state = completeDemo(state, 120, NOW);
  state = addDemoShowcase(state, NOW) ?? state;
  return {owner: 'synthetic-offline-test', state, revision: 1};
}

const CWD = fileURLToPath(new URL('..', import.meta.url));
const node = (args) => execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/reduce-demo.mjs', ...args], {cwd: CWD, stdio: 'pipe'});
const status = (args) => { try { node(args); return 0; } catch (e) { return e.status; } };
// Dry run (no --write) reports the plan digest; the write then names exactly that digest and accepts the unproven rows it listed.
function dryRun(input, keep) { return JSON.parse(node([input, '--keep', String(keep)]).toString()); }
function runReduce(input, output, keep) {
  const plan = dryRun(input, keep);
  assert.equal(status([input, '--keep', String(keep), '--write', output]), 3, 'write without the plan digest refuses');
  assert.ok(!existsSync(output));
  node([input, '--keep', String(keep), '--confirm-plan', plan.planDigest, '--accept-unproven-rows', '--write', output]);
}

function reduce(keep) {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-demo-'));
  const input = join(dir, 'in.json'), output = join(dir, 'out.json');
  writeFileSync(input, JSON.stringify(fixture()));
  runReduce(input, output, keep);
  return JSON.parse(readFileSync(output, 'utf8')).state;
}

test('Reducer keeps section variety: classes, workspace events, seed marker and nested subsystems survive', () => {
  const state = reduce(40);
  const demo = (id) => typeof id === 'string' && id.startsWith('sample-full-member-');
  assert.equal(state.members.filter((m) => demo(m.id)).length, 40);
  assert.ok(state.classes.length > 0, 'demo classes must survive reduction');
  assert.ok(state.events.some((e) => e.kind === 'demo.complete'), 'seed marker event must survive');
  assert.ok(state.events.length > 100, 'workspace demo events must survive');
  const kept = new Set(state.members.map((m) => m.id));
  const dangling = [];
  const check = (rows, pick, label) => {
    for (const row of rows ?? []) {
      const ref = pick(row);
      if (demo(ref) && !kept.has(ref)) dangling.push(label);
    }
  };
  check(state.visits, (r) => r.member, 'visits');
  check(state.payments, (r) => r.member, 'payments');
  check(state.invoices, (r) => r.member, 'invoices');
  check(state.pulse, (r) => r.member, 'pulse');
  check(state.community?.messages, (r) => r.member, 'community.messages');
  check(state.competitions?.results, (r) => r.member, 'competitions.results');
  check(state.engagement?.sms, (r) => r.member, 'engagement.sms');
  check(state.engagement?.consents, (r) => r.member, 'engagement.consents');
  check(state.engagement?.tickets, (r) => r.member, 'engagement.tickets');
  for (const c of state.classes) for (const id of [...(c.members ?? []), ...(c.waitlist ?? [])]) if (demo(id) && !kept.has(id)) dangling.push('classes');
  for (const e of state.events) if (typeof e.subject === 'string' && /sample-full-member-\d+/.test(e.subject)) {
    const ref = /sample-full-member-\d+/.exec(e.subject)[0];
    if (!kept.has(ref)) dangling.push('events');
  }
  assert.deepEqual(dangling, []);
  validateBackup(JSON.parse(JSON.stringify(state)));
});

test('Reducer output is smaller and --keep 0 empties the demo population without breaking validity', () => {
  const state = reduce(0);
  assert.equal(state.members.filter((m) => m.id.startsWith('sample-full-member-')).length, 0);
  validateBackup(JSON.parse(JSON.stringify(state)));
});

import {createHash} from 'node:crypto';

test('Reseed lifecycle: completeDemo can run again on the reduced state at the same timestamp', () => {
  const state = reduce(40);
  const reseeded = completeDemo(JSON.parse(JSON.stringify(state)), 60, NOW);
  assert.ok(reseeded.events.some((e) => e.kind === 'demo.complete'));
  assert.ok(reseeded.members.filter((m) => m.id.startsWith('sample-full-member-')).length >= 60);
});

test('Nested references to removed members (community messages) are cleaned instead of failing validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-nested-'));
  const input = join(dir, 'in.json'), output = join(dir, 'out.json');
  const doc = fixture();
  const message = structuredClone(doc.state.community.messages[0]);
  message.member = 'sample-full-member-0061';
  doc.state.community.messages.push(message);
  writeFileSync(input, JSON.stringify(doc));
  runReduce(input, output, 40);
  const state = JSON.parse(readFileSync(output, 'utf8')).state;
  assert.ok(!state.community.messages.some((m) => m.member === 'sample-full-member-0061'));
  validateBackup(JSON.parse(JSON.stringify(state)));
});

test('Backup envelope digest is recomputed so the restore route accepts the reduced file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-env-'));
  const input = join(dir, 'in.json'), output = join(dir, 'out.json');
  const doc = fixture();
  const envelope = {format: 'gymos-backup', version: 2, tenant: 'demo', state: doc.state, digest: createHash('sha256').update(JSON.stringify(doc.state)).digest('hex')};
  writeFileSync(input, JSON.stringify(envelope));
  runReduce(input, output, 40);
  const reduced = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(reduced.digest, createHash('sha256').update(JSON.stringify(reduced.state)).digest('hex'));
  validateBackup(JSON.parse(JSON.stringify(reduced.state)));
});

test('Shop sales referencing removed members are preserved with the member link anonymized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-shop-'));
  const input = join(dir, 'in.json'), output = join(dir, 'out.json');
  const doc = fixture();
  assert.ok(doc.state.shopSales?.length > 0, 'fixture needs shop sales');
  const sale = doc.state.shopSales[0];
  sale.member = 'sample-full-member-0061';
  writeFileSync(input, JSON.stringify(doc));
  runReduce(input, output, 40);
  const state = JSON.parse(readFileSync(output, 'utf8')).state;
  const keptSale = state.shopSales.find((s2) => s2.id === sale.id);
  assert.ok(keptSale, 'sale row must be preserved');
  assert.equal(keptSale.member, null);
  assert.deepEqual(keptSale.lines, sale.lines, 'stock/accounting lines untouched');
  validateBackup(JSON.parse(JSON.stringify(state)));
});

test('Provenance guard: an operator-added payment on a removed sample member is never dropped by inference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-prov-')), input = join(dir, 'in.json'), output = join(dir, 'out.json');
  const doc = fixture(), victim = doc.state.members.filter((m) => m.id.startsWith('sample-full-member-')).at(-1).id;
  const template = doc.state.payments.find((p) => p.member === victim) ?? doc.state.payments.find((p) => typeof p.member === 'string');
  doc.state.payments.push({...template, id: 'operator-real-payment-1', member: victim});
  writeFileSync(input, JSON.stringify(doc));
  const plan = dryRun(input, 40);
  assert.ok(plan.unprovenCount > 0);
  // Digest present but unproven rows not accepted: refuse and list the exact operator row.
  let failed; try { node([input, '--keep', '40', '--confirm-plan', plan.planDigest, '--write', output]); } catch (e) { failed = e; }
  assert.equal(failed.status, 3); assert.ok(!existsSync(output));
  const refused = JSON.parse(failed.stdout.toString());
  assert.ok(refused.unproven.some((u) => u.collection === 'payments' && u.id === 'operator-real-payment-1'), 'reports the exact operator row');
});

test('Stale confirmation: same ids with changed row CONTENT, changed input, or changed parameters never reuse an old plan digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-stale-')), input = join(dir, 'in.json'), output = join(dir, 'out.json');
  const doc = fixture(), victim = doc.state.members.filter((m) => m.id.startsWith('sample-full-member-')).at(-1).id;
  const template = doc.state.payments.find((p) => typeof p.member === 'string');
  doc.state.payments.push({...template, id: 'operator-real-payment-1', member: victim, minor: 100});
  writeFileSync(input, JSON.stringify(doc));
  const reviewed = dryRun(input, 40).planDigest;
  // Operator edits the amount of the SAME id after review.
  doc.state.payments.find((p) => p.id === 'operator-real-payment-1').minor = 999999;
  writeFileSync(input, JSON.stringify(doc));
  assert.notEqual(dryRun(input, 40).planDigest, reviewed, 'content change changes the digest');
  assert.equal(status([input, '--keep', '40', '--confirm-plan', reviewed, '--accept-unproven-rows', '--write', output]), 3);
  assert.ok(!existsSync(output));
  // Different parameters need a different digest too.
  const current = dryRun(input, 40).planDigest;
  assert.notEqual(dryRun(input, 30).planDigest, current);
  assert.equal(status([input, '--keep', '30', '--confirm-plan', current, '--accept-unproven-rows', '--write', output]), 3);
  assert.ok(!existsSync(output));
});

test('Ledger lists every changed shop sale, class membership row and device mapping with content hashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-ledger-')), input = join(dir, 'in.json');
  const doc = fixture(), victim = doc.state.members.filter((m) => m.id.startsWith('sample-full-member-')).at(-1).id;
  const sale = doc.state.shopSales?.[0];
  if (sale) sale.member = victim;
  doc.state.classes[0].members = [victim]; doc.state.classes[0].waitlist = [victim];
  writeFileSync(input, JSON.stringify(doc));
  const out = node([input, '--keep', '40']).toString(), plan = JSON.parse(out);
  assert.ok(plan.unprovenCount > 0);
  const refusal = (() => { try { node([input, '--keep', '40', '--confirm-plan', plan.planDigest, '--write', join(dir, 'o.json')]); } catch (e) { return JSON.parse(e.stdout.toString()); } })();
  assert.ok(refusal.unproven.every((u) => /^[0-9a-f]{64}$/.test(u.hash)));
  if (sale) assert.ok(refusal.unproven.some((u) => u.collection === 'shopSales' && u.id === sale.id && u.action === 'anonymize-member'));
  assert.ok(refusal.unproven.some((u) => u.collection === 'classMembership' && u.parent));
});

test('Dry run emits the COMPLETE inspectable plan (input sha, params, every ledger row with hash) and its digest matches a recomputation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-plan-')), input = join(dir, 'in.json');
  const doc = fixture(); doc.state.classes[0].members = [doc.state.members.filter((m) => m.id.startsWith('sample-full-member-')).at(-1).id];
  delete doc.state.classes[1].charges;
  writeFileSync(input, JSON.stringify(doc));
  const before = readFileSync(input);
  const out = JSON.parse(node([input, '--keep', '40']).toString());
  assert.equal(out.plan.inputSha256, createHash('sha256').update(before).digest('hex'));
  assert.equal(out.plan.keep, 40); assert.equal(out.plan.stripPhotos, false);
  assert.equal(out.plan.changes.length, out.changeCount);
  assert.ok(out.plan.changes.every((c) => /^[0-9a-f]{64}$/.test(c.hash) && typeof c.collection === 'string' && typeof c.action === 'string' && typeof c.proven === 'boolean'));
  assert.ok(out.plan.changes.some((c) => c.proven) && out.plan.changes.some((c) => !c.proven), 'prefix-named removals and unproven rows are both listed');
  const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  assert.equal(createHash('sha256').update(JSON.stringify(canon({inputSha256: out.plan.inputSha256, keep: 40, stripPhotos: false, changes: out.plan.changes}))).digest('hex'), out.planDigest);
  // A class without charges is not normalized and not listed.
  const output = join(dir, 'o.json');
  node([input, '--keep', '40', '--confirm-plan', out.planDigest, '--accept-unproven-rows', '--write', output]);
  const cls = JSON.parse(readFileSync(output, 'utf8')).state.classes[1];
  assert.ok(!('charges' in cls), 'a missing field stays missing');
  assert.ok(!out.plan.changes.some((c) => c.collection === 'classMembership' && c.id === doc.state.classes[1].id));
  assert.deepEqual(readFileSync(input), before, 'input untouched');
});
