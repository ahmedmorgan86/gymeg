import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {androidAppVariants} from '../app/lib/support-release.ts';
import {checkReleaseVersionLabels,sha256,versionFromApkFilename} from '../scripts/release-integrity.mjs';

const manifest = JSON.parse(await readFile(new URL('../public/downloads/apk-supersessions.json', import.meta.url), 'utf8'));

test('duplicate APK labels are declared in the download supersession manifest', () => {
  assert.equal(manifest.schema, 'gymeg.apk-supersessions.v1');
  assert.equal(manifest.filesPreserved, true);
  assert.equal(manifest.aliases.length, 5);
  const pairs = manifest.aliases.map(alias => `${alias.superseded} -> ${alias.identicalTo}`).sort();
  assert.deepEqual(pairs, [
    'GymEG-Manager-Android-1.1.3.apk -> GymEG-Manager-Android-1.1.4.apk',
    'GymEG-Members-Android-1.1.3.apk -> GymEG-Members-Android-1.1.4.apk',
    'GymEG-Manager-Legacy-Android-1.0.2.apk -> GymEG-Manager-Legacy-Android-1.0.3.apk',
    'GymEG-Members-Legacy-Android-1.0.3.apk -> GymEG-Members-Legacy-Android-1.0.4.apk',
    'GymEG-Support-Android-1.0.3.apk -> GymEG-Support-Android-1.0.4.apk',
  ].sort());
});

test('every superseded label is byte-identical to its canonical counterpart and both files remain', async () => {
  for (const alias of manifest.aliases) {
    assert.equal(alias.status, 'superseded-alias');
    assert.ok(alias.reason.length > 20);
    const older = new URL(`../public/downloads/${alias.superseded}`, import.meta.url);
    const canonical = new URL(`../public/downloads/${alias.identicalTo}`, import.meta.url);
    assert.equal(existsSync(older), true, `Missing preserved file ${alias.superseded}`);
    assert.equal(existsSync(canonical), true, `Missing canonical file ${alias.identicalTo}`);
    const [olderBytes, canonicalBytes] = await Promise.all([readFile(older), readFile(canonical)]);
    assert.equal(olderBytes.length, alias.bytes);
    assert.equal(canonicalBytes.length, alias.bytes);
    assert.equal(sha256(olderBytes), alias.sha256);
    assert.equal(sha256(canonicalBytes), alias.sha256, `${alias.identicalTo} is not byte-identical to ${alias.superseded}`);
    assert.ok(versionFromApkFilename(alias.superseded) < versionFromApkFilename(alias.identicalTo));
  }
});

test('active download UI never advertises a superseded APK label', () => {
  const supersededUrls = new Set(manifest.aliases.map(alias => `/downloads/${alias.superseded}`));
  for (const variant of androidAppVariants) assert.equal(supersededUrls.has(variant.url), false, `${variant.id} still advertises a superseded APK`);
});

test('current release metadata matches the manifest and would reject the old duplicate labels', async () => {
  const files = {management: 'gymeg-management-android.json', members: 'gymeg-members-android.json', support: 'support-android.json'};
  const advertised = [];
  for (const [role, file] of Object.entries(files)) {
    const metadata = JSON.parse(await readFile(new URL(`../public/downloads/${file}`, import.meta.url), 'utf8'));
    assert.equal(path.basename(metadata.url), manifest.currentReleases[role]);
    assert.equal(existsSync(new URL(`../public${metadata.url}`, import.meta.url)), true);
    advertised.push({role, package: metadata.package, version: metadata.version, url: metadata.url, bytes: metadata.bytes, sha256: metadata.sha256});
  }
  assert.deepEqual(checkReleaseVersionLabels(advertised), []);
  const alias = manifest.aliases[0];
  const issues = checkReleaseVersionLabels([
    {role: 'old', package: 'com.pushtorq.management', version: versionFromApkFilename(alias.superseded), url: `/downloads/${alias.superseded}`, bytes: alias.bytes, sha256: alias.sha256},
    {role: 'canonical', package: 'com.pushtorq.management', version: versionFromApkFilename(alias.identicalTo), url: `/downloads/${alias.identicalTo}`, bytes: alias.bytes, sha256: alias.sha256},
  ]);
  assert.ok(issues.some(issue => issue.includes('another version label')));
});
