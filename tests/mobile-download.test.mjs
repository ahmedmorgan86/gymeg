import {test} from 'node:test';import assert from 'node:assert/strict';import {existsSync,readFileSync} from 'node:fs';import {mobileDownloadResponse} from '../app/lib/mobile-download.ts';import {androidAppVariants,supportApkFilename,supportApkUrl,supportApkVersion,supportInstallPath,managementApkFilename,managementApkUrl,managementApkVersion,managementInstallPath,membersApkFilename,membersApkUrl,membersApkVersion,membersInstallPath,resolveSupportApkUrl,resolveSupportInstallUrl,resolveManagementApkUrl,resolveManagementInstallUrl,resolveMembersApkUrl,resolveMembersInstallUrl} from '../app/lib/support-release.ts';
for(const web of ['/clubs','/member','/support-login'])test('QR routes safely by platform for '+web,()=>{for(const [ua,want] of [['Mozilla Android 15','/downloads/app.apk'],['Mozilla iPhone OS 18',web],['Mozilla iPad',web],['Desktop',web],['',web]]){const r=mobileDownloadResponse(new Request('https://pushtorq.vercel.app/mobile/member',{headers:{'user-agent':ua}}),'/downloads/app.apk',web);assert.equal(r.status,307);assert.equal(r.headers.get('location'),want);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('vary'),'User-Agent');}});

test('Pending original-key APK upgrade opens the working new-origin web app on Android',()=>{const r=mobileDownloadResponse(new Request('https://pushtorq.vercel.app/mobile/member',{headers:{'user-agent':'Android'}}),'/downloads/old.apk','/member',false);assert.equal(r.headers.get('location'),'/member');assert.match(r.headers.get('cache-control'),/no-store/);});

test('Platform support, management and members download metadata map to latest downloadable APKs and resolve deployment URLs dynamically',()=>{
 assert.equal(androidAppVariants.length,3);
 for(const variant of androidAppVariants){
  assert.match(variant.version,/^\d+\.\d+\.\d+$/);
  assert.equal(variant.url,`/downloads/${variant.filename}`);
  assert.equal(existsSync(new URL('../public'+variant.url,import.meta.url)),true,`Missing APK artifact for ${variant.id}: ${variant.url}`);
 }
 assert.equal(supportApkVersion,'1.0.6');
 assert.equal(managementApkVersion,'1.1.8');
 assert.equal(membersApkVersion,'1.1.7');
 const managementRelease=JSON.parse(readFileSync(new URL('../public/downloads/gymeg-management-android.json',import.meta.url),'utf8'));
 assert.equal(managementRelease.versionCode,10);
 assert.equal(managementRelease.requiresReinstallFromPreviousBrand,false);
 assert.equal(supportApkUrl,`/downloads/${supportApkFilename}`);
 assert.equal(managementApkUrl,`/downloads/${managementApkFilename}`);
 assert.equal(membersApkUrl,`/downloads/${membersApkFilename}`);
 assert.equal(resolveSupportApkUrl('https://deploy-preview.gymeg.example/platform'),`https://deploy-preview.gymeg.example${supportApkUrl}`);
 assert.equal(resolveSupportInstallUrl('https://deploy-preview.gymeg.example/platform'),`https://deploy-preview.gymeg.example${supportInstallPath}`);
 assert.equal(resolveManagementApkUrl('https://deploy-preview.gymeg.example/platform'),`https://deploy-preview.gymeg.example${managementApkUrl}`);
 assert.equal(resolveManagementInstallUrl('https://deploy-preview.gymeg.example/platform'),`https://deploy-preview.gymeg.example${managementInstallPath}`);
 assert.equal(resolveMembersApkUrl('https://deploy-preview.gymeg.example/platform'),`https://deploy-preview.gymeg.example${membersApkUrl}`);
 assert.equal(resolveMembersInstallUrl('https://deploy-preview.gymeg.example/platform'),`https://deploy-preview.gymeg.example${membersInstallPath}`);
});

