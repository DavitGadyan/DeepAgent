import type { Metadata } from 'next';
import { RunsView } from '@/components/runs/RunsView';

export const metadata: Metadata = { title: 'Runs' };

export default function RunsPage() {
  return <RunsView />;
}
