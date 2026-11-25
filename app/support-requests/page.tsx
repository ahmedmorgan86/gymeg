import { notFound } from 'next/navigation';
import { requireChatGPTUser } from '../chatgpt-auth';
import { isFirestorePersistence } from '../lib/firestore-db';
import { platformAuthority } from '../lib/platform-authority';
import SupportRequests from './support-requests';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'طلبات الدعم | GymEG', robots: { index: false, follow: false } };

export default async function SupportRequestsPage({ searchParams }: { searchParams: Promise<{ platform?: string }> }) {
  const { platform } = await searchParams;
  const user = await requireChatGPTUser(platform === '1' ? '/support-requests?platform=1' : '/support-requests');
  if (platform === '1' && !(await platformAuthority(user))) notFound();
  return <SupportRequests platform={platform === '1'} userId={user.userId} available={isFirestorePersistence()} />;
}
