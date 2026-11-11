/** Event builders for the unit tests: one event per second starting at T0. */
import type { AgentId, EventType, PipelineEvent } from '@/lib/types';

export const T0 = Date.parse('2026-01-05T09:00:00Z');

export function makeEvents() {
  let seq = 0;

  const event = (
    agent: AgentId,
    type: EventType,
    fields: Partial<PipelineEvent> = {},
  ): PipelineEvent => {
    const ts = new Date(T0 + seq * 1000).toISOString();
    seq += 1;
    return {
      id: `e${seq}`,
      ts,
      run_id: 'run-1',
      agent,
      type,
      job_id: '',
      title: '',
      duration_ms: null,
      data: {},
      ...fields,
    };
  };

  const item = (
    agent: AgentId,
    type: EventType,
    job: string,
    data: Record<string, unknown> = {},
    durationMs: number | null = null,
  ) => event(agent, type, { job_id: job, title: `Job ${job}`, data, duration_ms: durationMs });

  const source = (type: EventType, name: string, data: Record<string, unknown> = {}) =>
    event('scout', type, { data: { source: name, ...data } });

  return { event, item, source };
}
