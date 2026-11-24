import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkReleaseVersionLabels,checkSourceHashes,parseApksignerCertificate,selectApkVerifier,sha256} from './release-integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releases = [
  {role: 'management', manifest: 'mobile-android/management/AndroidManifest.xml', metadata: 'public/downloads/gymeg-management-android.json'},
  {role: 'members', manifest: 'mobile-android/members/AndroidManifest.xml', metadata: 'public/downloads/gymeg-members-android.json'},
  {role: 'support', manifest: 'android-support/AndroidManifest.xml', metadata: 'public/downloads/support-android.json'},
];
const verifier = selectApkVerifier({existsSync,readdirSync});
const advertised = [];

for (const release of releases) {
  const manifest = await readFile(path.join(root, release.manifest), 'utf8');
  const metadata = JSON.parse(await readFile(path.join(root, release.metadata), 'utf8'));
  const attr = name => new RegExp(`android:${name}="([^"]+)"`).exec(manifest)?.[1];
  const pkg = /<manifest[^>]+\bpackage="([^"]+)"/.exec(manifest)?.[1];
  assert.ok(pkg, `${release.role}: manifest package is missing`);
  assert.equal(metadata.package, pkg, `${release.role}: package differs from release metadata`);
  assert.equal(metadata.version, attr('versionName'), `${release.role}: versionName differs from release metadata`);
  assert.equal(metadata.versionCode, Number(attr('versionCode')), `${release.role}: versionCode differs from release metadata`);
  assert.equal(metadata.origin, 'https://gymeg.vercel.app', `${release.role}: unexpected origin`);
  assert.equal(metadata.url, `/downloads/${path.basename(metadata.url)}`, `${release.role}: APK URL must be local to downloads`);

  const apkPath = path.join(root, 'public', metadata.url.replace(/^\//, ''));
  const [apk, info] = await Promise.all([readFile(apkPath), stat(apkPath)]);
  assert.ok(info.size > 0 && apk.length > 0, `${release.role}: APK entry is empty`);
  assert.equal(info.size, metadata.bytes, `${release.role}: APK byte size mismatch`);
  assert.equal(sha256(apk), metadata.sha256, `${release.role}: APK SHA-256 mismatch`);
  assert.ok(metadata.certificateSha256, `${release.role}: signing certificate fingerprint is missing`);
  assert.equal(typeof metadata.physicalDeviceTested, 'boolean', `${release.role}: physical-device status must be explicit`);

  const sourceDir = path.dirname(path.join(root, release.manifest));
  const sourceIssues = await checkSourceHashes(metadata.sourceHashes, sourceDir, readFile);
  assert.deepEqual(sourceIssues, [], `${release.role}: source hash check failed — ${sourceIssues.join('; ')}`);
  const sourceCount = Object.keys(metadata.sourceHashes ?? {}).length;
  if (!sourceCount) console.log(`${release.role}: sourceHashes absent (nothing to verify locally)`);

  if (verifier) {
    const output = execFileSync(verifier.command, [...verifier.prefix, 'verify', '--verbose', '--print-certs', apkPath], {encoding: 'utf8'});
    const digests = parseApksignerCertificate(output);
    assert.ok(digests.length > 0 && digests.every(digest => digest === metadata.certificateSha256.toLowerCase()), `${release.role}: signing certificate differs from release metadata`);
    assert.match(output, /^Number of signers: 1$/m, `${release.role}: expected exactly one APK signer`);
    console.log(`${release.role}: signing certificate VERIFIED with ${verifier.label}`);
  } else {
    console.log(`${release.role}: signing certificate UNVERIFIED (no apksigner/keytool available; metadata hash is not proof of signature)`);
  }

  advertised.push({role: release.role, version: metadata.version, package: metadata.package, url: metadata.url, bytes: metadata.bytes, sha256: metadata.sha256});
  console.log(`${release.role}: ${metadata.version} (${metadata.versionCode}), APK and metadata agree; ${sourceCount} source hashes checked`);
}

const labelIssues = checkReleaseVersionLabels(advertised);
assert.deepEqual(labelIssues, [], `Release labels: ${labelIssues.join('; ')}`);
console.log(`APK labels: ${advertised.length} advertised releases are non-empty, unique and honestly labelled`);

const windowsProject = await readFile(path.join(root, 'windows/GymOS.Windows.csproj'), 'utf8');
const windowsRelease = await readFile(path.join(root, 'app/lib/windows-release.ts'), 'utf8');
const sourceVersion = /<Version>([^<]+)<\/Version>/.exec(windowsProject)?.[1];
const publishedVersion = /windowsVersion='([^']+)'/.exec(windowsRelease)?.[1];
const candidateVersion = /windowsSourceVersion='([^']+)'/.exec(windowsRelease)?.[1];
assert.ok(sourceVersion, 'Windows project version is missing');
assert.equal(candidateVersion, sourceVersion, 'Windows candidate differs from the current source project');
assert.ok(publishedVersion, 'Verified downloadable Windows version is missing');
assert.match(windowsRelease, /windows-\$\{windowsVersion\}\/GymEG-Windows-x64-\$\{windowsVersion\}\.exe/, 'Fallback download URL must be built from the version advertised on the website');
console.log(`Windows: source ${sourceVersion}; verified published download ${publishedVersion}`);
