import Link from 'next/link';
import {redirect,notFound} from 'next/navigation';
import {getChatGPTUser} from '../chatgpt-auth';
import {commercialEnabled,commercialDirectory} from '../lib/commercial';
import CommercialPanel from '../commercial-panel';
import {platformAuthority} from '../lib/platform-authority';
export const metadata={title:'GymEG Support',robots:{index:false,follow:false},manifest:'/support.webmanifest',appleWebApp:{capable:true,title:'GymEG Support',statusBarStyle:'default' as const},icons:{icon:'/icons/support-192.png?v=20261029-gymeg',apple:'/icons/support-180.png?v=20261029-gymeg'}};
export const dynamic='force-dynamic';
export default async function Platform(){const user=await getChatGPTUser();if(!user)redirect('/support-login');if(!commercialEnabled()||!(await platformAuthority(user)))notFound();return <><nav aria-label="Support"><Link href="/support-requests?platform=1">طلبات الدعم / Support requests</Link></nav><CommercialPanel platform initialData={await commercialDirectory(user,true)}/></>;}
