'use client';
import { Square } from 'lucide-react';
import { useState } from 'react';
import { type ApiError, api, toApiError } from '@/lib/api';
import type { Run } from '@/lib/types';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { InlineError } from '@/components/ui/States';

/**
 * Stops the run that is shown. Asks first: the jobs that wait and the ones in
 * progress are let go and do not come back by themselves.
 */
export function StopRunButton({ run, onStopped }: { run: Run; onStopped: (run: Run) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const stop = async () => {
    setAsking(false);
    setBusy(true);
    setError(null);
    try {
      onStopped(await api.stopRun(run.id));
    } catch (reason) {
      setError(toApiError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <InlineError error={error} />
      <button
        type="button"
        className="btn btn--danger"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        <Square size={13} aria-hidden="true" />
        {busy ? 'Stopping…' : 'Stop run'}
      </button>
      <ConfirmDialog
        open={asking}
        title="Stop this run?"
        confirmLabel="Stop run"
        onConfirm={stop}
        onCancel={() => setAsking(false)}
      >
        <p>
          The scout sends no more jobs. The {run.stats.in_flight} job
          {run.stats.in_flight === 1 ? '' : 's'} still in the pipeline are let go: the ones that
          wait, and the ones an agent works on now.
        </p>
        <p>
          Leads already found stay, with what the agents added so far. A new run can pick the jobs
          up again with Force.
        </p>
      </ConfirmDialog>
    </>
  );
}
