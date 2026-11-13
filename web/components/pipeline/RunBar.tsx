import { formatDateTime } from '@/lib/format';
import type { Run, RunStats } from '@/lib/types';
import { RunStatusPill } from '@/components/ui/badges';
import { StartRunButton } from './StartRunButton';
import { StopRunButton } from './StopRunButton';

const STATS: { key: keyof RunStats; label: string }[] = [
  { key: 'discovered', label: 'discovered' },
  { key: 'dropped', label: 'dropped' },
  { key: 'failed', label: 'failed' },
  { key: 'scored', label: 'scored' },
  { key: 'researched', label: 'researched' },
  { key: 'in_flight', label: 'in flight' },
];

export function RunStatsList({ stats }: { stats: RunStats }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.74rem] text-muted tabular-nums">
      {STATS.map(({ key, label }) => (
        <li key={key}>
          <b className="mr-1 text-[0.82rem] font-bold text-fg">{stats[key]}</b>
          {label}
        </li>
      ))}
    </ul>
  );
}

/** Above the graph: which run is shown, how it is doing, and the buttons to stop it and to start a new one. */
export function RunBar({
  runs,
  selected,
  workers,
  onSelect,
  onStarted,
  onStopped,
}: {
  runs: Run[];
  selected: Run | undefined;
  /** How many parallel workers the agents have now. */
  workers: number;
  onSelect: (runId: string) => void;
  onStarted: (run: Run) => void;
  onStopped: (run: Run) => void;
}) {
  return (
    <div className="card flex flex-wrap items-center gap-x-4 gap-y-2 !py-2.5">
      <label className="flex items-center gap-2">
        <span className="label">Run</span>
        <select
          className="field"
          value={selected?.id ?? ''}
          disabled={runs.length === 0}
          onChange={(change) => onSelect(change.target.value)}
        >
          {runs.length === 0 && <option value="">No runs yet</option>}
          {runs.map((run, index) => (
            <option key={run.id} value={run.id}>
              {formatDateTime(run.started_at)}
              {index === 0 ? ' (latest)' : ''}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <RunStatusPill status={selected.status} />
          <RunStatsList stats={selected.stats} />
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        {selected?.status === 'running' && <StopRunButton run={selected} onStopped={onStopped} />}
        <StartRunButton workers={workers} onStarted={onStarted} />
      </div>
    </div>
  );
}
