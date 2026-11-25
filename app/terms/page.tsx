import type {Metadata} from 'next';
import LegalPage from '../legal-page';

export const dynamic='force-dynamic';
export const metadata:Metadata={title:'GymEG — Terms of Service | شروط الخدمة'};

export default async function TermsPage({searchParams}:{searchParams:Promise<{lang?:string}>}){
 const {lang}=await searchParams;
 return <LegalPage kind="terms" en={lang==='en'}/>;
}
