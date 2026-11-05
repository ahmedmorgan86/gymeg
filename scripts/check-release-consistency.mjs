import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releases = [
  {role: 'management', manifest: 'mobile-android/management/AndroidManifest.xml', metadata: 'public/downloads/gymeg-management-android.json'},
  {role: 'members', manifest: 'mobile-android/members/AndroidManifest.xml', metadata: 'public/downloads/gymeg-members-android.json'},
  {role: 'support', manifest: 'android-support/AndroidManifest.xml', metadata: 'public/downloads/support-android.json'},
];

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
  assert.equal(info.size, metadata.bytes, `${release.role}: APK byte size mismatch`);
  assert.equal(createHash('sha256').update(apk).digest('hex'), metadata.sha256, `${release.role}: APK SHA-256 mismatch`);
  assert.ok(metadata.certificateSha256, `${release.role}: signing certificate fingerprint is missing`);
  assert.equal(typeof metadata.physicalDeviceTested, 'boolean', `${release.role}: physical-device status must be explicit`);
  console.log(`${release.role}: ${metadata.version} (${metadata.versionCode}), APK and metadata agree`);
}

const windowsProject = await readFile(path.join(root, 'windows/GymOS.Windows.csproj'), 'utf8');
assert.match(windowsProject, /<Version>1\.1\.15<\/Version>/, 'Windows project version differs from the current release record');
console.log('Windows: 1.1.15');
