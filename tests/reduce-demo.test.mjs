import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

function reduce(keep) {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-demo-'));
  const input = join(dir, 'in.json'), output = join(dir, 'out.json');
  writeFileSync(input, JSON.stringify(fixture()));
  execFileSync('node', ['--experimental-strip-types', 'scripts/reduce-demo.mjs', input, '--keep', String(keep), '--write', output], {cwd: new URL('..', import.meta.url).pathname});
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
  execFileSync('node', ['--experimental-strip-types', 'scripts/reduce-demo.mjs', input, '--keep', '40', '--write', output], {cwd: new URL('..', import.meta.url).pathname});
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
  execFileSync('node', ['--experimental-strip-types', 'scripts/reduce-demo.mjs', input, '--keep', '40', '--write', output], {cwd: new URL('..', import.meta.url).pathname});
  const reduced = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(reduced.digest, createHash('sha256').update(JSON.stringify(reduced.state)).digest('hex'));
  validateBackup(JSON.parse(JSON.stringify(reduced.state)));
});
