import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LeadsView } from '@/components/leads/LeadsView';
import { Loading } from '@/components/ui/States';

export const metadata: Metadata = { title: 'Leads' };

export default function LeadsPage() {
  // LeadsView reads the filters from the query string, which needs a Suspense boundary.
  return (
    <Suspense fallback={<Loading label="Loading leads…" />}>
      <LeadsView />
    </Suspense>
  );
}
