import type { Metadata } from 'next';
import { LeadDetail } from '@/components/leads/LeadDetail';

export const metadata: Metadata = { title: 'Lead' };

export default async function LeadPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <LeadDetail jobId={jobId} />;
}
