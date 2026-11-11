import { Suspense } from 'react';
import { PipelineView } from '@/components/pipeline/PipelineView';
import { Loading } from '@/components/ui/States';

export default function PipelinePage() {
  return (
    <Suspense fallback={<Loading label="Loading the pipeline…" />}>
      <PipelineView />
    </Suspense>
  );
}
