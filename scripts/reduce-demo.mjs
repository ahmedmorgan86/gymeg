import {readFileSync, writeFileSync} from 'node:fs';
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

const doc = JSON.parse(readFileSync(input, 'utf8'));
const state = doc.state ?? doc;
const beforeBytes = JSON.stringify(doc).length;

const demoMembers = state.members.filter((m) => m.id.startsWith(DEMO + 'member-'));
const kept = new Set(demoMembers.slice(0, keep).map((m) => m.id));
const removed = new Set(demoMembers.slice(keep).map((m) => m.id));

const counts = {membersBefore: demoMembers.length, membersKept: kept.size, dropped: {}};
const drop = (name, rows, predicate) => {
  if (!Array.isArray(rows)) return rows;
  const next = rows.filter((r) => !predicate(r));
  counts.dropped[name] = rows.length - next.length;
  return next;
};

state.members = state.members.filter((m) => !removed.has(m.id));
for (const name of ['visits', 'payments', 'pulse', 'invoices', 'followUps', 'trainingAssignments', 'coaching']) {
  if (state[name]) state[name] = drop(name, state[name], (r) => removed.has(r.member));
}
if (state.trainingSessions) {
  const keptAssignments = new Set(state.trainingAssignments?.map((a) => a.id) ?? []);
  state.trainingSessions = drop('trainingSessions', state.trainingSessions, (r) => !keptAssignments.has(r.assignment));
}
if (state.classes) {
  // Demo classes stay even when emptied: removing them deletes the whole
  // class section, and the generator itself seeds some classes empty.
  for (const c of state.classes) {
    c.members = (c.members ?? []).filter((id) => !removed.has(id));
    c.waitlist = (c.waitlist ?? []).filter((id) => !removed.has(id));
    c.charges = (c.charges ?? []).filter((ch) => !removed.has(ch.member));
  }
}
// Nested subsystem references the top-level cleanup misses.
if (state.community?.messages) state.community.messages = drop('communityMessages', state.community.messages, (r) => removed.has(r.member));
// Shop sales are accounting rows: preserve them (and their stock links) but
// anonymize the removed member link, exactly as walk-in sales are stored.
for (const sale of state.shopSales ?? []) {
  if (removed.has(sale.member)) { sale.member = null; counts.dropped.shopSalesAnonymized = (counts.dropped.shopSalesAnonymized ?? 0) + 1; }
}
if (state.competitions?.results) state.competitions.results = drop('competitionResults', state.competitions.results, (r) => removed.has(r.member));
if (state.engagement) {
  for (const key of ['consents', 'sms', 'tickets']) {
    if (state.engagement[key]) state.engagement[key] = drop('engagement.' + key, state.engagement[key], (r) => removed.has(r.member));
  }
  for (const d of state.engagement.devices ?? []) {
    if (d.mappings) d.mappings = d.mappings.filter((m) => !removed.has(m.member));
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
  for (const m of state.members) if (m.id.startsWith(DEMO) && m.photo) { delete m.photo; stripped++; }
  for (const p of state.products ?? []) if (p.id.startsWith(DEMO) && p.photo) { delete p.photo; stripped++; }
  counts.dropped.photos = stripped;
}

validateBackup(JSON.parse(JSON.stringify(state)));
if (doc.state) doc.state = state; else Object.assign(doc, state);
const afterBytes = JSON.stringify(doc).length;
console.log(JSON.stringify({...counts, valid: true, beforeBytes, afterBytes, savedBytes: beforeBytes - afterBytes}, null, 2));
if (out) {
  if (doc && typeof doc.digest === 'string') doc.digest = createHash('sha256').update(JSON.stringify(doc.state)).digest('hex');
  writeFileSync(out, JSON.stringify(doc));
  console.log('Wrote ' + out);
}
