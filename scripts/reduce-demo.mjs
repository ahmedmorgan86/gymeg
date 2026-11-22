import {readFileSync, statSync} from 'node:fs';
import {writeNewFile} from './safe-write.mjs';
import {createHash} from 'node:crypto';
import {validateBackup} from '../app/lib/backup.ts';

// Offline demo-dataset reducer: shrinks the fictional 'sample-full-' demo
// population inside a GymEG JSON backup to --keep members (default 60),
// dropping every row that references removed demo members, then re-validates
// the result with the app's own backup validator. Local files only; it never
// touches a backend. Dry-run by default; pass --write OUT.json to save.
//
// Usage: node --experimental-strip-types scripts/reduce-demo.mjs backup.json [--keep N] [--strip-photos] [--write out.json]

const DEMO = 'sample-full-';
const args = process.argv.slice(2), input = args[0];
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const keep = Number(flag('--keep', '60')), stripPhotos = args.includes('--strip-photos'), out = flag('--write', null);
if (!input || !Number.isInteger(keep) || keep < 0) throw Error('Usage: node --experimental-strip-types scripts/reduce-demo.mjs backup.json [--keep N] [--strip-photos] [--write out.json]');

if (statSync(input).size > 256 * 1024 * 1024) throw Error('refusing: input file larger than 256 MiB');
const rawBytes = readFileSync(input);
const doc = JSON.parse(rawBytes.toString('utf8'));
// Same supported-input rule as compress-images.mjs: a v2 envelope with a matching digest, or a bare state. v3 and anything else fail closed.
if (doc && typeof doc === 'object' && 'format' in doc) {
  if (doc.format !== 'gymos-backup' || doc.version !== 2 || typeof doc.state !== 'object' || doc.state === null) throw Error('refusing: unsupported backup envelope (only v2 is supported; v3 backups keep photos outside the state)');
  if (typeof doc.digest === 'string' && doc.digest !== createHash('sha256').update(JSON.stringify(doc.state)).digest('hex')) throw Error('refusing: envelope digest does not match its state');
} else if (!Array.isArray(doc?.members) && !Array.isArray(doc?.state?.members)) throw Error('refusing: input is not a v2 backup envelope, a {state} wrapper or a state object');
const state = doc.state ?? doc;
const beforeBytes = JSON.stringify(doc).length;

const demoMembers = state.members.filter((m) => m.id.startsWith(DEMO + 'member-'));
const kept = new Set(demoMembers.slice(0, keep).map((m) => m.id));
const removed = new Set(demoMembers.slice(keep).map((m) => m.id));

const counts = {membersBefore: demoMembers.length, membersKept: kept.size, dropped: {}};
// Change ledger. EVERY row this run removes or changes is recorded with the sha256 of its ORIGINAL canonical content, its parent
// identity (class id, device id, sale id) and whether it is provably generated. An own-id demo prefix is only a naming convention:
// it says the row was named like generated data, not that it is still unchanged, so provability here is "prefix present" and the
// write confirmation below binds to the row CONTENT hashes as well. Rows that are not provable (no prefix, touched pulse rows,
// shop sales, class member/waitlist entries) additionally need --accept-unproven-rows.
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const sha = (v) => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(canon(v))).digest('hex');
const changes = [];
const note = (collection, row, action, parent, proven) => changes.push({collection, id: typeof row?.id === 'string' ? row.id : null, parent: parent ?? null, action, proven, hash: sha(row)});
const provable = (name, r) => {
  if (typeof r?.id !== 'string') return false;
  if (name === 'pulse') return r.id.startsWith('pulse-v1|') && typeof r.member === 'string' && r.id.split('|')[2] === r.member && r.member.startsWith(DEMO) && r.status === 'proposed' && (r.note ?? '') === '' && r.decidedDay === undefined;
  return r.id.startsWith(DEMO);
};
const drop = (name, rows, predicate, parent) => {
  if (!Array.isArray(rows)) return rows;
  for (const r of rows) if (predicate(r)) note(name, r, 'remove', parent, provable(name, r));
  const next = rows.filter((r) => !predicate(r));
  counts.dropped[name] = (counts.dropped[name] ?? 0) + rows.length - next.length;
  return next;
};

state.members = state.members.filter((m) => !removed.has(m.id));
for (const m of demoMembers.slice(keep)) note('members', m, 'remove', null, provable('members', m));
for (const name of ['visits', 'payments', 'pulse', 'invoices', 'followUps', 'trainingAssignments', 'coaching']) {
  if (state[name]) state[name] = drop(name, state[name], (r) => removed.has(r.member));
}
if (state.trainingSessions) {
  const keptAssignments = new Set(state.trainingAssignments?.map((a) => a.id) ?? []);
  state.trainingSessions = drop('trainingSessions', state.trainingSessions, (r) => !keptAssignments.has(r.assignment));
}
if (state.classes) {
  // Demo classes stay even when emptied. Member and waitlist entries are bare ids, so the whole ORIGINAL class row is hashed
  // as the changed row (parent = class id) and counted unproven: nothing proves those lists were never edited by an operator.
  for (const c of state.classes) {
    const before = sha(c), dropMembers = (c.members ?? []).filter((id) => removed.has(id)), dropWait = (c.waitlist ?? []).filter((id) => removed.has(id));
    if (dropMembers.length || dropWait.length) changes.push({collection: 'classMembership', id: c.id ?? null, parent: c.id ?? null, action: 'filter-members:' + dropMembers.join(',') + '|waitlist:' + dropWait.join(','), proven: false, hash: before});
    // Assign only when a field exists or something is removed: a missing members/waitlist/charges is never normalized to [].
    if (dropMembers.length) c.members = c.members.filter((id) => !removed.has(id));
    if (dropWait.length) c.waitlist = c.waitlist.filter((id) => !removed.has(id));
    if (Array.isArray(c.charges)) c.charges = drop('classCharges', c.charges, (ch) => removed.has(ch.member), c.id ?? null);
  }
}
// Nested subsystem references the top-level cleanup misses.
if (state.community?.messages) state.community.messages = drop('communityMessages', state.community.messages, (r) => removed.has(r.member));
// Shop sales are accounting rows: preserve them and anonymize the removed member link, as walk-in sales are stored. This CHANGES
// an operator-visible accounting row regardless of its id, so every one is a ledger entry and counts as unproven.
for (const sale of state.shopSales ?? []) {
  if (removed.has(sale.member)) { note('shopSales', sale, 'anonymize-member', null, false); sale.member = null; counts.dropped.shopSalesAnonymized = (counts.dropped.shopSalesAnonymized ?? 0) + 1; }
}
if (state.competitions?.results) state.competitions.results = drop('competitionResults', state.competitions.results, (r) => removed.has(r.member));
if (state.engagement) {
  for (const key of ['consents', 'sms', 'tickets']) {
    if (state.engagement[key]) state.engagement[key] = drop('engagement.' + key, state.engagement[key], (r) => removed.has(r.member));
  }
  for (const d of state.engagement.devices ?? []) {
    // Mappings may have no id of their own: the parent device id is part of the identity and the row content hash is recorded.
    if (d.mappings) d.mappings = drop('deviceMappings', d.mappings, (m) => removed.has(m.member), d.id ?? null);
  }
}
// Events: drop only events ABOUT removed members (subjects can be compound,
// e.g. pulse-v1|expired|<member-id>|...). Workspace and demo-section events,
// including the demo.complete seed marker, stay so the activity log survives.
if (state.events) {
  const removedList = [...removed];
  const aboutRemoved = (subject) => typeof subject === 'string' && removedList.some((id) => subject.includes(id));
  state.events = drop('events', state.events, (r) => aboutRemoved(r.subject));
}
if (stripPhotos) {
  let stripped = 0;
  for (const m of state.members) if (m.id.startsWith(DEMO) && m.photo) { note('members', m, 'strip-photo', null, true); delete m.photo; stripped++; }
  for (const p of state.products ?? []) if (p.id.startsWith(DEMO) && p.photo) { note('products', p, 'strip-photo', null, true); delete p.photo; stripped++; }
  counts.dropped.photos = stripped;
}

// Plan digest: sha256 over the raw input bytes, the operation parameters and every ledger entry (collection, id, parent, action,
// original-content hash). Any change to the file, to any affected row (even the same id with a different amount) or to --keep or
// --strip-photos produces a different digest, so a digest from an earlier run can never authorise a different plan. The digest is a
// reviewed PLAN identifier printed by a dry run; it is not the user's permission to change real data, which is separate.
changes.sort((x, y) => (x.collection + '\t' + (x.id ?? '') + '\t' + (x.parent ?? '') + '\t' + x.action).localeCompare(y.collection + '\t' + (y.id ?? '') + '\t' + (y.parent ?? '') + '\t' + y.action));
const planDigest = sha({inputSha256: sha(rawBytes), keep, stripPhotos, changes});
const unproven = changes.filter((c) => !c.proven);
const confirmPlan = flag('--confirm-plan', null), acceptUnproven = args.includes('--accept-unproven-rows');
if (out) {
  if (confirmPlan !== planDigest) {
    console.log(JSON.stringify({refused: true, reason: 'writing requires --confirm-plan with the digest of THIS exact input and plan; nothing written', plan: {inputSha256: sha(rawBytes), keep, stripPhotos, planDigest, changes}, planDigest, changeCount: changes.length, unprovenCount: unproven.length, unproven}, null, 2));
    process.exit(3);
  }
  if (unproven.length && !acceptUnproven) {
    console.log(JSON.stringify({refused: true, reason: 'plan changes rows that are not provably generated demo data; nothing written', planDigest, unprovenCount: unproven.length, unproven, confirmWith: '--accept-unproven-rows after review'}, null, 2));
    process.exit(3);
  }
}
validateBackup(JSON.parse(JSON.stringify(state)));
if (doc.state) doc.state = state; else Object.assign(doc, state);
const afterBytes = JSON.stringify(doc).length;
console.log(JSON.stringify({...counts, plan: {inputSha256: sha(rawBytes), keep, stripPhotos, planDigest, changeCount: changes.length, unprovenCount: unproven.length, changes}, planDigest, changeCount: changes.length, unprovenCount: unproven.length, valid: true, beforeBytes, afterBytes, savedBytes: beforeBytes - afterBytes}, null, 2));
if (out) {
  if (doc && typeof doc.digest === 'string') doc.digest = createHash('sha256').update(JSON.stringify(doc.state)).digest('hex');
  writeNewFile(input, out, JSON.stringify(doc));
  console.log('Wrote ' + out);
}
