/**
 * Types of the orchestrator API, copied from docs/api.md and
 * packages/common/leadscout_common/schemas.py. Keep the three in step.
 */

export type AgentId =
  'scout' | 'filter' | 'extractor' | 'scorer' | 'researcher' | 'applier' | 'orchestrator';

export type EventType =
  | 'run.started'
  | 'run.finished'
  | 'source.started'
  | 'source.finished'
  | 'source.failed'
  | 'scout.done'
  | 'item.started'
  | 'item.finished'
  | 'item.dropped'
  | 'item.failed'
  | 'item.waiting';

/** `Event` in the API docs; renamed here so it does not shadow the DOM `Event`. */
export interface PipelineEvent {
  id: string;
  ts: string;
  /** '' for applier events outside a run */
  run_id: string;
  agent: AgentId;
  type: EventType;
  /** '' for run.* and source.* events */
  job_id: string;
  title: string;
  duration_ms: number | null;
  data: Record<string, unknown>;
}

export type NodeKind = 'source' | 'tool' | 'llm' | 'deep' | 'human' | 'store';

export interface PipelineNode {
  /** agent id, or 'source:<name>' */
  id: string;
  label: string;
  kind: NodeKind;
  description: string;
  /** '' when the node uses no model */
  model: string;
  /** sources have parent 'scout' */
  parent?: string;
  enabled: boolean;
}

export interface PipelineEdge {
  source: string;
  target: string;
}

export interface Pipeline {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

export interface RunOptions {
  sources: string[];
  /** 0 means "the Setup value"; only runs stored before the effective value was saved have it. */
  limit_per_source: number;
  force: boolean;
}

export interface RunStats {
  discovered: number;
  dropped: number;
  failed: number;
  scored: number;
  researched: number;
  in_flight: number;
}

export interface Run {
  id: string;
  status: 'running' | 'finished';
  started_at: string;
  finished_at: string | null;
  options: RunOptions;
  stats: RunStats;
}

export const LEAD_STATUSES = [
  'new',
  'scored',
  'researched',
  'tailoring',
  'cv_ready',
  'filling',
  'form_filled',
  'applied',
  'skipped',
  'failed',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface LeadSummary {
  job_id: string;
  status: LeadStatus;
  score: number | null;
  title: string;
  company: string;
  location: string;
  source: string;
  url: string;
  remote_policy: string;
  seniority: string;
  role_family: string;
  posted_at: string | null;
  updated_at: string;
}

export interface JobPosting {
  source: string;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  posted_at: string | null;
  remote: boolean | null;
  salary: string;
  tags: string[];
}

export interface ExtractedJob {
  role_family: string;
  seniority: string;
  remote_policy: string;
  contract_type: string;
  locations: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  required_skills: string[];
  nice_to_have_skills: string[];
  years_experience: number | null;
  summary: string;
  // The four below are absent on leads extracted before they existed.
  /** One sentence: what the company does. */
  company_one_liner?: string;
  /** Up to 5 short bullets: what you will do. */
  responsibilities?: string[];
  /** Up to 6 short bullets: must-haves, in the posting's terms. */
  requirements?: string[];
  /** Up to 5 short bullets: pay extras, perks, working conditions. */
  benefits?: string[];
}

export interface FitScore {
  score: number;
  rationale: string;
  matched_skills: string[];
  missing_skills: string[];
  concerns: string[];
  /** Points per rubric part (skills, role, seniority, logistics); may be empty or absent. */
  breakdown?: Record<string, number>;
}

export interface CompanyBrief {
  what_they_do: string;
  stage_and_funding: string;
  ai_stack: string;
  hiring_contact: string;
  sources: string[];
}

export interface Application {
  dir: string;
  files: string[];
  unanswered: string[];
  /**
   * Why the last applier step did not finish. With status 'failed' the
   * tailoring failed; with 'cv_ready' a form fill did (no form found, a
   * login or CAPTCHA wall, a crash) and the CV is still usable.
   */
  error: string;
  // The two below are absent on applications written before they existed.
  /** What Claude Code's sessions for this lead cost, summed, at API prices; null when unknown. */
  cost_usd?: number | null;
  /** Form fields the agent filled. */
  filled_fields?: string[];
}

/** The pipeline agents whose failure on a posting is recorded on the lead. */
export type PipelineStage = 'filter' | 'extractor' | 'scorer' | 'researcher';

/** The last pipeline step that failed on this job; cleared once that agent succeeds. */
export interface PipelineError {
  agent: PipelineStage;
  error: string;
}

export interface Lead extends LeadSummary {
  job: JobPosting;
  extracted: ExtractedJob | null;
  score_detail: FitScore | null;
  brief: CompanyBrief | null;
  application: Application | null;
  pipeline_error: PipelineError | null;
}

export interface LeadPage {
  items: LeadSummary[];
  total: number;
}

export interface LeadQuery {
  min_score?: number;
  status?: LeadStatus;
  source?: string;
  remote?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

/** GET /api/events: events outside any run. Only the applier writes those. */
export interface EventQuery {
  agent: 'applier';
  /** ISO timestamp; events at or after it. */
  since: string;
  /** Default 500, at most 2000. */
  limit?: number;
}

export interface Settings {
  /** adapter name -> enabled */
  sources: Record<string, boolean>;
  keywords: string[];
  exclude_keywords: string[];
  /** 0-100 */
  research_min_score: number;
  limit_per_source: number;
}
