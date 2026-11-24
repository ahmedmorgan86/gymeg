import MemberApp from '../member/member-app';
import {memberPreview} from '../lib/member-preview';
import {connection} from 'next/server';
export const metadata={title:'GymEG — معاينة تطبيق العضو',robots:{index:false,follow:false}};
export default async function MemberPreview(){await connection();return <MemberApp previewData={memberPreview(new Date().toISOString())}/>;}
