'use client';
import { ChevronDown, Play } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { type ApiError, api, toApiError } from '@/lib/api';
import type { Run } from '@/lib/types';
import { InlineError } from '@/components/ui/States';

/** "Start run" with a small popover for the two options a run takes. */
export function StartRunButton({ onStarted }: { onStarted: (run: Run) => void }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const start = async (submit: FormEvent) => {
    submit.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // An empty limit is left out so the orchestrator applies the one from Setup.
      const run = await api.startRun({
        force,
        ...(limit ? { limit_per_source: Number(limit) } : {}),
      });
      setOpen(false);
      onStarted(run);
    } catch (reason) {
      setError(toApiError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className="btn btn--primary"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <Play size={14} aria-hidden="true" />
        Start run
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <form className="popover grid gap-3" onSubmit={start} aria-label="Run options">
          <label className="grid gap-1">
            <span className="label">Limit per source</span>
            <input
              type="number"
              className="field"
              min={1}
              max={500}
              placeholder="Use the Setup default"
              value={limit}
              onChange={(change) => setLimit(change.target.value)}
            />
          </label>
          <label className="flex items-start gap-2 text-[0.8rem] leading-snug">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={force}
              onChange={(change) => setForce(change.target.checked)}
            />
            <span>
              Force
              <span className="block text-muted">
                Re-process postings already seen in earlier runs.
              </span>
            </span>
          </label>
          <InlineError error={error} />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </form>
      )}
    </div>
  );
}
