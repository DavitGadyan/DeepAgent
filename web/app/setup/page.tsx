import type { Metadata } from 'next';
import { SetupView } from '@/components/setup/SetupView';

export const metadata: Metadata = { title: 'Setup' };

export default function SetupPage() {
  return <SetupView />;
}
