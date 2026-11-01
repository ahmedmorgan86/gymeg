/** Prefer the verified new release only after GitHub makes its asset public. */
export const windowsVersion='1.1.15';
export const windowsCurrent='https://github.com/ahmedmorgan86/gymeg/releases/download/windows-1.1.15/GymEG-Windows-x64-1.1.15.exe';
export const windowsPrevious='https://github.com/ahmedmorgan86/gymeg/releases/download/windows-1.1.14/GymEG-Windows-x64-1.1.14.exe';
export async function windowsDownload(fetcher:typeof fetch=fetch){
 try{
  const response=await fetcher('https://api.github.com/repos/ahmedmorgan86/gymeg/releases/tags/windows-1.1.15',{headers:{Accept:'application/vnd.github+json','User-Agent':'GymEG-download-service'},cache:'force-cache',next:{revalidate:60},signal:AbortSignal.timeout(4000)});
  if(!response.ok)return windowsPrevious;
  const release=await response.json();
  if(release.draft===false&&release.tag_name==='windows-1.1.15'&&Array.isArray(release.assets)&&release.assets.some((asset:{name?:unknown;state?:unknown;size?:unknown;browser_download_url?:unknown})=>asset.name==='GymEG-Windows-x64-1.1.15.exe'&&asset.state==='uploaded'&&typeof asset.size==='number'&&asset.size>0&&asset.browser_download_url===windowsCurrent))return windowsCurrent;
 }catch{}
 return windowsPrevious;
}
