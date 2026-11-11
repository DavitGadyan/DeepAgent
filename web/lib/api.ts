import type {
  EventQuery,
  Lead,
  LeadPage,
  LeadQuery,
  Pipeline,
  PipelineEvent,
  Run,
  RunOptions,
  Settings,
} from './types';

/** Baked in at build time; see `.env.example`. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000').replace(
  /\/+$/,
  '',
);

/** `status` is null when the request never reached the orchestrator. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get unreachable(): boolean {
    return this.status === null;
  }
}

export const toApiError = (error: unknown): ApiError =>
  error instanceof ApiError ? error : new ApiError(String(error), null);

/** FastAPI reports errors as `{ "detail": ... }`. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'detail' in body) {
      const { detail } = body;
      return typeof detail === 'string' ? detail : JSON.stringify(detail);
    }
  } catch {
    // not JSON: fall through to the status line
  }
  return `${res.status} ${res.statusText}`.trim();
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(`Can't reach the orchestrator at ${API_URL}`, null);
  }
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  return (await res.json()) as T;
}

function leadQueryString(query: LeadQuery): string {
  const params = new URLSearchParams();
  if (query.min_score) params.set('min_score', String(query.min_score));
  if (query.status) params.set('status', query.status);
  if (query.source) params.set('source', query.source);
  if (query.remote) params.set('remote', 'true');
  if (query.q) params.set('q', query.q);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  const text = params.toString();
  return text ? `?${text}` : '';
}

const lead = (jobId: string) => `/api/leads/${encodeURIComponent(jobId)}`;

export const api = {
  pipeline: () => request<Pipeline>('/api/pipeline'),

  runs: () => request<Run[]>('/api/runs'),
  startRun: (options: Partial<RunOptions>) => request<Run>('/api/runs', 'POST', options),
  runEvents: (runId: string) =>
    request<PipelineEvent[]>(`/api/runs/${encodeURIComponent(runId)}/events`),
  /** Oldest first. */
  events: ({ agent, since, limit }: EventQuery) => {
    const params = new URLSearchParams({ agent, since });
    if (limit !== undefined) params.set('limit', String(limit));
    return request<PipelineEvent[]>(`/api/events?${params}`);
  },

  leads: (query: LeadQuery) => request<LeadPage>(`/api/leads${leadQueryString(query)}`),
  lead: (jobId: string) => request<Lead>(lead(jobId)),
  /** 'new' puts the lead back where the pipeline left it: cv_ready when it has files. */
  setLeadStatus: (jobId: string, status: 'new' | 'skipped' | 'applied') =>
    request<Lead>(lead(jobId), 'PATCH', { status }),
  tailor: (jobId: string) => request<Lead>(`${lead(jobId)}/tailor`, 'POST'),
  apply: (jobId: string) => request<Lead>(`${lead(jobId)}/apply`, 'POST'),

  settings: () => request<Settings>('/api/settings'),
  saveSettings: (settings: Settings) => request<Settings>('/api/settings', 'PUT', settings),
};

export const eventStreamUrl = `${API_URL}/api/events/stream`;

export const leadFileUrl = (jobId: string, name: string) =>
  `${API_URL}${lead(jobId)}/files/${encodeURIComponent(name)}`;
