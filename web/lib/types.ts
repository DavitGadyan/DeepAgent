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
  | 'item.waiting'
  /** A node of the agent's LangGraph graph started: data.node, data.resumed?. */
  | 'item.progress';

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
  /** Every item.* event of a pipeline agent has `worker` (1..N): which parallel worker. */
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
  /** Agents: how many jobs it handles at the same time (scout and applier: 1). */
  workers: number;
  /** The agent's LangGraph graph; null when it is not a graph or has not started yet. */
  graph: GraphShape | null;
  /** Agents that are not graphs: what they do, in order. */
  steps: string[];
}

export interface PipelineEdge {
  source: string;
  target: string;
}

/** Nodes and edges of one agent's LangGraph graph. Start and end are '__start__', '__end__'. */
export interface GraphShape {
  nodes: { id: string; label: string }[];
  edges: { source: string; target: string; conditional: boolean }[];
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
  /** Parallel workers per agent. Sent as 0 or left out to keep the current count. */
  workers: number;
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
  /** 'stopped': the user stopped it; its waiting and unfinished jobs were let go. */
  status: 'running' | 'finished' | 'stopped';
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
  'in_review',
  'interview',
  'rejected',
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
  /** When LeadScout found the posting. */
  created_at: string;
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
  // The fields below are absent on applications written before they existed.
  /** When the application was sent, for one made before LeadScout or outside it. */
  applied_at?: string | null;
  /** Where a prior application comes from. */
  note?: string;
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

export type LeadSort = 'newest' | 'score';

export interface LeadQuery {
  min_score?: number;
  status?: LeadStatus;
  source?: string;
  remote?: boolean;
  q?: string;
  /** ISO timestamps bounding when LeadScout found the posting (after: inclusive). */
  found_after?: string;
  found_before?: string;
  /** Default 'newest'. */
  sort?: LeadSort;
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
  claude_access: ClaudeAccess;
  /** USD cap per Claude Code session; 0 = no cap. */
  tailor_budget_usd: number;
  fill_budget_usd: number;
  /** Tailor CV model: '' = Claude Code's default, an alias, or a full model name. */
  tailor_model: string;
  /** Claude spend allowed per month in USD; 0 = no limit. */
  monthly_budget_usd: number;
  /** Rows of the pipeline, 1-16: each row is one worker of every agent. */
  workers: number;
}

export const MAX_WORKERS = 16;

/** GET /api/costs. All amounts are USD at API prices. */
export interface CostAmount {
  usd: number;
  /** The part paid with a Console API key. */
  billed_usd: number;
  sessions: number;
}

export interface CostSlice extends CostAmount {
  key: string;
  label: string;
}

export interface CostDay {
  /** YYYY-MM-DD, the viewer's local day. */
  date: string;
  login_usd: number;
  console_usd: number;
}

export interface CostReport {
  today: CostAmount;
  last_7_days: CostAmount;
  this_month: CostAmount;
  all_time: CostAmount;
  monthly_budget_usd: number;
  /** One entry per day, oldest first, days without spend included. */
  by_day: CostDay[];
  by_action: CostSlice[];
  by_model: CostSlice[];
  by_access: CostSlice[];
  top_leads: { job_id: string; title: string; usd: number; sessions: number }[];
  /** `langfuse` is '' when tracing is off. */
  links: { console_billing: string; langfuse: string };
}

/** login: your Claude account (subscription). console: ANTHROPIC_API_KEY, billed per token. */
export type ClaudeAccess = 'login' | 'console';

/** What the applier worker reports; the API returns null when it is not running. */
export interface ApplierStatus {
  api_key_set: boolean;
  logged_in: boolean;
  /** e.g. "claude.ai" */
  auth_method: string;
  /** e.g. "max", "pro" */
  subscription: string;
  updated_at: string;
}

/** `data/profile/profile.yaml`. Every value is free text; empty means not stated. */
export interface UserProfile {
  /** Read by the scorer. */
  preferences: Record<string, string>;
  /** Read only by the form-filling agent. */
  application: Record<string, string>;
}
