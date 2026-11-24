/** Latest Windows package verified in the public download repository. */
export const windowsVersion='1.1.17';
/** Candidate must match the Windows project version and a published public release. */
export const windowsSourceVersion='1.1.17';
const releaseRepository='ahmedmorgan86/gymeg-downloads';
export const windowsCurrent=`https://github.com/${releaseRepository}/releases/download/windows-${windowsSourceVersion}/GymEG-Windows-x64-${windowsSourceVersion}.exe`;
export const windowsPrevious=`https://github.com/${releaseRepository}/releases/download/windows-${windowsVersion}/GymEG-Windows-x64-${windowsVersion}.exe`;

export async function windowsDownload(fetcher:typeof fetch=fetch){
 try{
  const response=await fetcher(`https://api.github.com/repos/${releaseRepository}/releases/tags/windows-${windowsSourceVersion}`,{headers:{Accept:'application/vnd.github+json','User-Agent':'GymEG-download-service'},cache:'force-cache',next:{revalidate:60},signal:AbortSignal.timeout(4000)});
  if(!response.ok)return windowsPrevious;
  const release=await response.json();
  if(release.draft===false&&release.tag_name===`windows-${windowsSourceVersion}`&&Array.isArray(release.assets)&&release.assets.some((asset:{name?:unknown;state?:unknown;size?:unknown;browser_download_url?:unknown})=>asset.name===`GymEG-Windows-x64-${windowsSourceVersion}.exe`&&asset.state==='uploaded'&&typeof asset.size==='number'&&asset.size>0&&asset.browser_download_url===windowsCurrent))return windowsCurrent;
 }catch{}
 return windowsPrevious;
}
