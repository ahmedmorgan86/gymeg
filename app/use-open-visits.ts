"use client";
// OFF (default): the check-in profile popup keeps comparing the packet's visits (checkinProfile). ON (NEXT_PUBLIC_GYMOS_OPEN_VISITS=1): setPacket also asks the server for the branch's open visits
// and compares them with the previous read of the same owner and branch (same selection rule). null = no usable answer (the packet comparison stays the only source).
export const OPEN_ON=process.env.NEXT_PUBLIC_GYMOS_OPEN_VISITS==='1';
export type OpenVisit={id:string;member:string;at:string;activeAt?:string};
export async function fetchOpenVisits(owner:string,branch:string):Promise<OpenVisit[]|null>{
  try{
    const r=await fetch('/api/workspace/open-visits?branch='+encodeURIComponent(branch),{headers:{'X-GymOS-Tenant':owner},cache:'no-store'});
    const d=r.ok?await r.json() as {status?:string;open?:OpenVisit[]}:null;
    return d&&d.status==='ok'&&Array.isArray(d.open)?d.open:null;
  }catch{return null;}
}
