/**
 * The event log shown for one run: the run's own events plus the applier's
 * work, which happens outside any run (run_id '') once the user presses a
 * button on a lead page.
 */
import type { PipelineEvent } from '@/lib/types';

/** The part of a Run the log needs. */
export interface RunWindow {
  id: string;
  started_at: string;
}

/** The run's own events, and applier events from its start onwards. */
export function belongsToRun(event: PipelineEvent, run: RunWindow | null): boolean {
  if (event.run_id !== '') return event.run_id === run?.id;
  if (event.agent !== 'applier') return false;
  return run === null || Date.parse(event.ts) >= Date.parse(run.started_at);
}

const byTime = (a: PipelineEvent, b: PipelineEvent) => Date.parse(a.ts) - Date.parse(b.ts);

/**
 * `log` plus the events of `extra` it does not already contain (same id),
 * oldest first. Returns `log` itself when nothing is new, so React can skip
 * the re-render. The sort is stable: events with equal times keep their order.
 */
export function mergeEvents(log: PipelineEvent[], extra: PipelineEvent[]): PipelineEvent[] {
  const seen = new Set(log.map((event) => event.id));
  const added: PipelineEvent[] = [];
  for (const event of extra) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    added.push(event);
  }
  return added.length ? [...log, ...added].sort(byTime) : log;
}
