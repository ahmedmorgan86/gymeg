import {createHash} from 'node:crypto';
import {copyFileSync,readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(root,'..');
const cert=(process.env.GYMEG_ANDROID_CERT_SHA256??'').replaceAll(':','').toLowerCase();
if(!/^[a-f0-9]{64}$/.test(cert))throw Error('Set GYMEG_ANDROID_CERT_SHA256 to the verified signing certificate fingerprint.');
const apps=[
 {role:'management',folder:'management',module:'manager',name:'Manager',version:'1.1.8',versionCode:10,package:'com.pushtorq.management',home:'/clubs'},
 {role:'members',folder:'members',module:'members',name:'Members',version:'1.1.7',versionCode:9,package:'com.pushtorq.members',home:'/member'},
 {role:'support',folder:'../android-support',module:'support',name:'Support',version:'1.0.6',versionCode:7,package:'com.gymos.support',home:'/support-login'}
];
const requestedRole=process.argv[2];
if(requestedRole&&!apps.some(app=>app.role===requestedRole))throw Error('Optional release target must be management, members, or support.');
const hash=value=>createHash('sha256').update(value).digest('hex');
function walk(dir){return readdirSync(dir).flatMap(name=>{const file=path.join(dir,name);return statSync(file).isDirectory()?walk(file):[file];});}
for(const app of apps.filter(app=>!requestedRole||app.role===requestedRole)){
 const source=path.resolve(root,app.folder);
 const apk=path.join(source,'build','outputs','apk','release',`${app.module}-release.apk`);
 const filename=`GymEG-${app.name}-Android-${app.version}.apk`;
 const destination=path.join(repo,'public','downloads',filename);
 const metadataPath=path.join(repo,'public','downloads',`${app.role==='support'?'support':`gymeg-${app.role}`}-android.json`);
 let previousCertificate='';
 try{previousCertificate=JSON.parse(readFileSync(metadataPath,'utf8')).certificateSha256??'';}catch{}
 copyFileSync(apk,destination);
 const files=[path.join(source,'AndroidManifest.xml'),...walk(path.join(source,'res')),...walk(path.join(source,'src'))].sort();
 const sourceHashes=Object.fromEntries(files.map(file=>[path.relative(source,file).split(path.sep).join('/'),hash(readFileSync(file))]));
 const apkBytes=readFileSync(destination);
 const meta={version:app.version,versionCode:app.versionCode,url:`/downloads/${filename}`,package:app.package,origin:'https://gymeg.vercel.app',home:app.home,minAndroid:'8.0',sha256:hash(apkBytes),bytes:apkBytes.length,certificateSha256:cert,builtAt:new Date().toISOString(),independentApplication:true,requiresReinstallFromPreviousBrand:previousCertificate?previousCertificate!==cert:app.package.startsWith('com.pushtorq.'),upgradeFromCertificateSha256:previousCertificate||cert,physicalDeviceTested:false,sourceHashes};
 writeFileSync(metadataPath,JSON.stringify(meta,null,2)+'\n');
 console.log(`${app.role}: ${filename} (${apkBytes.length} bytes)`);
}
