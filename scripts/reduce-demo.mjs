import {readFileSync, writeFileSync} from 'node:fs';
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
  for (const c of state.classes) {
    c.members = (c.members ?? []).filter((id) => !removed.has(id));
    c.waitlist = (c.waitlist ?? []).filter((id) => !removed.has(id));
    c.charges = (c.charges ?? []).filter((ch) => !removed.has(ch.member));
  }
  state.classes = drop('classes', state.classes, (c) => c.id.startsWith(DEMO) && c.members.length === 0 && c.waitlist.length === 0);
}
if (state.events) state.events = drop('events', state.events, (r) => r.id.startsWith(DEMO) || removed.has(r.subject));
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
  writeFileSync(out, JSON.stringify(doc));
  console.log('Wrote ' + out);
}
