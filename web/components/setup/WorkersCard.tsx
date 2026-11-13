import { MAX_WORKERS, type Settings } from '@/lib/types';

/** A whole number within 1..MAX_WORKERS, whatever was typed. */
const clampWorkers = (value: number) => Math.min(MAX_WORKERS, Math.max(1, Math.trunc(value) || 1));

/**
 * How many rows the pipeline has. A row is one worker of every agent (filter,
 * extractor, scorer, researcher); the scout deals the jobs of a run to the
 * rows in turn, and a job stays in its row.
 */
export function WorkersCard({
  value,
  onChange,
}: {
  value: Settings;
  onChange: <K extends keyof Settings>(key: K, next: Settings[K]) => void;
}) {
  return (
    <section className="card grid gap-4">
      <h2 className="card__title !mb-0">Workers</h2>
      <label className="grid content-start gap-1">
        <span className="label">Rows (workers per agent)</span>
        <input
          type="number"
          className="field w-24"
          min={1}
          max={MAX_WORKERS}
          required
          value={value.workers}
          onChange={(change) => onChange('workers', clampWorkers(Number(change.target.value)))}
        />
      </label>
      <p className="text-[0.76rem] text-muted">
        1 to {MAX_WORKERS}. Each row is a whole pipeline that works on one job per agent at a time;
        the scout gives every row the same share of a run&apos;s jobs. More rows help only when the
        model server can answer that many requests at once (vLLM on a GPU can; a CPU cannot). The
        Start run popover sets the same number. It applies to the next run.
      </p>
    </section>
  );
}
