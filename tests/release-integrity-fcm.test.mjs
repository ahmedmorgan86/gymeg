import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

test('support FCM sender is removed and has no remaining call sites', () => {
  const messaging = readFileSync(path.join(root, 'app/lib/firebase-messaging.ts'), 'utf8');
  assert.equal(messaging.includes('export async function sendSupportFcm'), false);
  assert.equal(messaging.includes('support_fcm_subscriptions'), false);
  assert.equal(messaging.includes('export async function sendCommunityFcm'), true);
  for (const file of sourceFiles(path.join(root, 'app'))) {
    if (file.endsWith(path.join('lib', 'firebase-messaging.ts'))) continue;
    const source = readFileSync(file, 'utf8');
    assert.equal(source.includes('sendSupportFcm'), false, `Stale support FCM call site: ${path.relative(root, file)}`);
  }
});
