import Link from 'next/link';
import {notFound} from 'next/navigation';
import {requireChatGPTUser} from '../chatgpt-auth';
import {commercialEnabled,commercialDirectory} from '../lib/commercial';
import CommercialPanel from '../commercial-panel';
export const dynamic='force-dynamic';
export default async function Clubs(){const user=await requireChatGPTUser('/clubs');if(!commercialEnabled())notFound();return <><nav aria-label="Support" style={{maxWidth:'1280px',margin:'0 auto',padding:'14px 32px 0',display:'flex',justifyContent:'flex-end'}}><Link href="/support-requests" style={{fontSize:'0.9rem',fontWeight:700}}>طلبات الدعم / Support requests</Link></nav><CommercialPanel initialData={await commercialDirectory(user)}/></>;}
