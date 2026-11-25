import type {Metadata} from 'next';
import LegalPage from '../legal-page';

export const dynamic='force-dynamic';
export const metadata:Metadata={title:'GymEG — Privacy Policy | سياسة الخصوصية'};

export default async function PrivacyPage({searchParams}:{searchParams:Promise<{lang?:string}>}){
 const {lang}=await searchParams;
 return <LegalPage kind="privacy" en={lang==='en'}/>;
}
