import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {checkReleaseVersionLabels,checkSourceHashes,parseApksignerCertificate,selectApkVerifier,sha256,versionFromApkFilename} from '../scripts/release-integrity.mjs';

const releaseEntries = [
  {role: 'management', package: 'com.pushtorq.management', version: '1.1.9', url: '/downloads/GymEG-Manager-Android-1.1.9.apk', bytes: 3183524, sha256: 'a'.repeat(64)},
  {role: 'members', package: 'com.pushtorq.members', version: '1.1.8', url: '/downloads/GymEG-Members-Android-1.1.8.apk', bytes: 3183248, sha256: 'b'.repeat(64)},
  {role: 'support', package: 'com.gymos.support', version: '1.0.7', url: '/downloads/GymEG-Support-Android-1.0.7.apk', bytes: 3183444, sha256: 'c'.repeat(64)},
];

test('APK version labels are parsed from real release filenames', () => {
  assert.equal(versionFromApkFilename('/downloads/GymEG-Manager-Android-1.1.9.apk'), '1.1.9');
  assert.equal(versionFromApkFilename('GymEG-Manager-Legacy-Android-1.0.3.apk'), '1.0.3');
  assert.equal(versionFromApkFilename('/downloads/no-label.apk'), null);
  assert.equal(versionFromApkFilename('/downloads/GymEG-Manager-Android-1.1.9.exe'), null);
});

test('advertised APK entries must be non-empty, honest and unique', () => {
  assert.deepEqual(checkReleaseVersionLabels(releaseEntries), []);
  const dishonest = checkReleaseVersionLabels([{...releaseEntries[0], version: '1.1.4'}]);
  assert.ok(dishonest.some(issue => issue.includes('differs from metadata version')));
  const empty = checkReleaseVersionLabels([{...releaseEntries[0], bytes: 0}]);
  assert.ok(empty.some(issue => issue.includes('must be positive')));
  const duplicateVersion = checkReleaseVersionLabels([releaseEntries[0], {...releaseEntries[0], role: 'copy'}]);
  assert.ok(duplicateVersion.some(issue => issue.includes('duplicates')));
  const duplicateBytes = checkReleaseVersionLabels([releaseEntries[0], {...releaseEntries[1], sha256: releaseEntries[0].sha256}]);
  assert.ok(duplicateBytes.some(issue => issue.includes('duplicate') && issue.includes('another version label')));
});

test('published release metadata passes the same label checks', async () => {
  const roles = [
    ['management', 'gymeg-management-android.json'],
    ['members', 'gymeg-members-android.json'],
    ['support', 'support-android.json'],
  ];
  const entries = [];
  for (const [role, file] of roles) {
    const metadata = JSON.parse(await readFile(new URL(`../public/downloads/${file}`, import.meta.url), 'utf8'));
    entries.push({role, package: metadata.package, version: metadata.version, url: metadata.url, bytes: metadata.bytes, sha256: metadata.sha256});
  }
  assert.deepEqual(checkReleaseVersionLabels(entries), []);
});

test('source hashes are verified against injected files and reject bad paths', async () => {
  const root = path.resolve('C:\\fake\\source');
  const files = new Map([
    [path.join(root, 'AndroidManifest.xml'), Buffer.from('manifest')],
    [path.join(root, 'src', 'Main.java'), Buffer.from('source')],
  ]);
  const read = async target => {
    if (!files.has(target)) throw new Error('missing');
    return files.get(target);
  };
  const hashes = {
    'AndroidManifest.xml': sha256(files.get(path.join(root, 'AndroidManifest.xml'))),
    'src/Main.java': sha256(files.get(path.join(root, 'src', 'Main.java'))),
  };
  assert.deepEqual(await checkSourceHashes(hashes, root, read), []);
  const mismatched = await checkSourceHashes({'AndroidManifest.xml': 'f'.repeat(64)}, root, read);
  assert.ok(mismatched.some(issue => issue.includes('mismatch')));
  const missing = await checkSourceHashes({'src/Missing.java': '0'.repeat(64)}, root, read);
  assert.ok(missing.some(issue => issue.includes('missing')));
  const traversal = await checkSourceHashes({'../outside.java': '0'.repeat(64)}, root, read);
  assert.ok(traversal.some(issue => issue.includes('escapes')));
  assert.deepEqual(await checkSourceHashes(undefined, root, read), []);
});

test('signing verifier selection never treats keytool alone as verification', () => {
  assert.equal(selectApkVerifier({env: {}, pathEnv: '', existsSync: () => false, readdirSync: () => []}), null);
  const envSigner = selectApkVerifier({env: {ANDROID_APK_SIGNER: 'C:\\sdk\\apksigner.bat'}, pathEnv: '', existsSync: () => false, readdirSync: () => []});
  assert.deepEqual(envSigner, {label: 'ANDROID_APK_SIGNER', command: 'C:\\sdk\\apksigner.bat', prefix: []});
  const jarSigner = selectApkVerifier({env: {ANDROID_APK_SIGNER_JAR: 'C:\\sdk\\apksigner.jar', JAVA: 'C:\\java\\java.exe'}, pathEnv: '', existsSync: () => false, readdirSync: () => []});
  assert.deepEqual(jarSigner, {label: 'ANDROID_APK_SIGNER_JAR', command: 'C:\\java\\java.exe', prefix: ['-jar', 'C:\\sdk\\apksigner.jar']});
  // Build the candidate with path.join so the fixture matches the host OS separator,
  // exactly as selectApkVerifier does (the runner can be Linux while platform is forced to win32).
  const apksignerJar = path.join('C:\\sdk', 'build-tools', '36.0.0', 'lib', 'apksigner.jar');
  const present = new Set([apksignerJar]);
  const sdkSigner = selectApkVerifier({env: {ANDROID_HOME: 'C:\\sdk'}, pathEnv: '', existsSync: candidate => present.has(candidate), readdirSync: () => ['36.0.0'], platform: 'win32'});
  assert.deepEqual(sdkSigner, {label: 'Android SDK 36.0.0 apksigner.jar', command: 'java', prefix: ['-jar', apksignerJar]});
  const keytoolOnly = selectApkVerifier({env: {}, pathEnv: `C:\\java${path.delimiter}`, existsSync: candidate => candidate.endsWith('keytool.exe'), readdirSync: () => [], platform: 'win32'});
  assert.equal(keytoolOnly, null);
});

test('apksigner certificate parsing reports only real digests', () => {
  const digest = 'd'.repeat(64);
  const output = `Number of signers: 1\ncertificate SHA-256 digest: ${digest.toUpperCase()}\n`;
  assert.deepEqual(parseApksignerCertificate(output), [digest]);
  assert.deepEqual(parseApksignerCertificate('verifies'), []);
  assert.deepEqual(parseApksignerCertificate('certificate SHA-256 digest: not-a-digest'), []);
});
