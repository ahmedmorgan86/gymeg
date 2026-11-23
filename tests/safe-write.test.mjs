import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, symlinkSync, linkSync, mkdirSync, existsSync, writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeNewFile} from '../scripts/safe-write.mjs';

const setup = () => { const dir = mkdtempSync(join(tmpdir(), 'safe-write-')), input = join(dir, 'in.json'); writeFileSync(input, 'ORIGINAL'); return {dir, input}; };
const unchanged = (input) => assert.equal(readFileSync(input, 'utf8'), 'ORIGINAL');

test('direct helper: same path, symlink to input, symlinked dir, existing file, dangling link all refuse and leave the input byte-identical', () => {
  const {dir, input} = setup();
  assert.throws(() => writeNewFile(input, input, 'X'), /refusing/); unchanged(input);
  symlinkSync(input, join(dir, 'link.json')); assert.throws(() => writeNewFile(input, join(dir, 'link.json'), 'X'), /refusing/); unchanged(input);
  linkSync(input, join(dir, 'hard.json')); assert.throws(() => writeNewFile(input, join(dir, 'hard.json'), 'X'), /refusing/); unchanged(input);
  symlinkSync(dir, join(dir, 'dirlink')); assert.throws(() => writeNewFile(input, join(dir, 'dirlink', 'in.json'), 'X'), /refusing/); unchanged(input);
  symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling.json')); assert.throws(() => writeNewFile(input, join(dir, 'dangling.json'), 'X'), /refusing/); assert.ok(!existsSync(join(dir, 'nowhere')));
  mkdirSync(join(dir, 'd')); assert.throws(() => writeNewFile(input, join(dir, 'd'), 'X'), /refusing/);
  unchanged(input);
});

test('direct helper: a fresh path is written completely and verified', () => {
  const {dir, input} = setup(); const out = join(dir, 'new.json'), data = 'x'.repeat(100000);
  writeNewFile(input, out, data); assert.equal(readFileSync(out, 'utf8'), data); unchanged(input);
});

test('short writes are looped until every byte is persisted', () => {
  const {dir, input} = setup(); const out = join(dir, 'short.json'), data = 'abcdefghij'.repeat(50);
  writeNewFile(input, out, data, {writeSync: (fd, buf, off, len) => writeSync(fd, buf, off, Math.min(len, 2))});
  assert.equal(readFileSync(out, 'utf8'), data);
});

test('fault injection: a write that stops making progress, or reports bytes it never wrote, fails and leaves no output', () => {
  const {dir, input} = setup();
  const stuck = join(dir, 'stuck.json');
  assert.throws(() => writeNewFile(input, stuck, 'abcdef', {writeSync: (fd, buf, off, len) => off === 0 ? writeSync(fd, buf, 0, 2) : 0}), /no progress/);
  assert.ok(!existsSync(stuck), 'incomplete output removed');
  const liar = join(dir, 'liar.json');
  assert.throws(() => writeNewFile(input, liar, 'abcdef', {writeSync: (fd, buf, off, len) => len}), /size does not match|verification failed/);
  assert.ok(!existsSync(liar));
  unchanged(input);
});
