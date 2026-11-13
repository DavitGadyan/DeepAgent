import type { Metadata } from 'next';
import { CostView } from '@/components/cost/CostView';

export const metadata: Metadata = { title: 'Cost' };

export default function CostPage() {
  return <CostView />;
}
