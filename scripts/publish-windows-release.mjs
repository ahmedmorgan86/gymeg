import {appendFileSync,createReadStream,statSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function releaseMetadata(version){
 if(typeof version!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw new Error('Invalid Windows release version.');
 return {tag:`windows-${version}`,name:`GymEG Windows x64 ${version}`,asset:`GymEG-Windows-x64-${version}.exe`};
}

function apiHeaders(token){return{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'};}

async function jsonRequest(url,{token,method='GET',body}={}){
 const response=await fetch(url,{method,headers:apiHeaders(token),...(body?{body:JSON.stringify(body)}:{})});
 const text=await response.text();let data={};try{data=text?JSON.parse(text):{};}catch{throw new Error(`GitHub returned an invalid response (${response.status}).`);}
 if(!response.ok)throw new Error(`GitHub API request failed (${response.status}): ${data.message??'unknown error'}`);
 return data;
}

function uploadAsset(uploadUrl,file,name,token,size){
 const url=new URL(uploadUrl.replace(/\{.*$/,''));url.searchParams.set('name',name);
 return new Promise((resolve,reject)=>{
  const request=https.request(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/octet-stream','Content-Length':String(size)}},response=>{
   const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');let data={};try{data=text?JSON.parse(text):{};}catch{return reject(new Error('GitHub returned an invalid asset upload response.'));}if(response.statusCode<200||response.statusCode>=300)return reject(new Error(`Release asset upload failed (${response.statusCode}): ${data.message??'unknown error'}`));resolve(data);});
  });
  request.setTimeout(180000,()=>request.destroy(new Error('Release asset upload timed out.')));
  request.on('error',reject);createReadStream(file).pipe(request);
 });
}

export async function publishWindowsRelease({token,repository,version,commit,file}){
 if(!token||!repository||!commit||!file)throw new Error('Missing GitHub release configuration.');
 const {tag,name,asset}=releaseMetadata(version);const [owner,repo]=repository.split('/');
 if(!owner||!repo||repository.split('/').length!==2)throw new Error('Invalid GitHub repository.');
 const size=statSync(file).size;if(size<1_000_000||size>250_000_000)throw new Error('Windows package size is outside the allowed range.');
 const digest=createHash('sha256').update(readFileSync(file)).digest('hex');
 const api=`https://api.github.com/repos/${owner}/${repo}`;
 let release;
 try{release=await jsonRequest(`${api}/releases/tags/${tag}`,{token});}
 catch(error){if(!String(error.message).includes('(404)'))throw error;release=await jsonRequest(`${api}/releases`,{token,method:'POST',body:{tag_name:tag,target_commitish:commit,name,body:`Built from commit ${commit}. SHA-256: ${digest}. This Windows executable is not signed with a trusted publisher certificate.`,draft:true,prerelease:false}});}
 const existing=(release.assets??[]).find(item=>item.name===asset);
 if(existing){
  const existingDigest=existing.digest?.replace(/^sha256:/,'');
  if(existingDigest!==digest)throw new Error(`A different ${asset} already exists; refusing to replace a published release asset.`);
 }else{
  await uploadAsset(release.upload_url,file,asset,token,size);
 }
 if(release.draft){release=await jsonRequest(`${api}/releases/${release.id}`,{token,method:'PATCH',body:{draft:false,name,body:`Built from commit ${commit}. SHA-256: ${digest}. This Windows executable is not signed with a trusted publisher certificate.`}});}
 return {tag,asset,size,digest,url:`https://github.com/${owner}/${repo}/releases/download/${tag}/${asset}`,release:release.html_url};
}

const scriptPath=process.argv[1]?path.resolve(process.argv[1]):'';
if(scriptPath===fileURLToPath(import.meta.url)){
 try{
  const result=await publishWindowsRelease({token:process.env.GITHUB_TOKEN,repository:process.env.GITHUB_REPOSITORY,version:process.env.WINDOWS_VERSION,commit:process.env.GITHUB_SHA,file:process.env.WINDOWS_PACKAGE_PATH});
  console.log(JSON.stringify(result));
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## Windows release published\n\n- Version: ${process.env.WINDOWS_VERSION}\n- File: ${result.asset}\n- Size: ${result.size} bytes\n- SHA-256: \`${result.digest}\`\n- Download: ${result.url}\n`);
 }catch(error){console.error(error.message);process.exitCode=1;}
}
