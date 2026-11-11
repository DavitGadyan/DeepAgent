import { humanize } from '@/lib/format';
import type { LeadStatus, Run } from '@/lib/types';

type Tone = 'good' | 'busy' | 'warn' | 'bad' | 'neutral';

const LEAD_TONE: Record<LeadStatus, Tone> = {
  new: 'neutral',
  scored: 'neutral',
  researched: 'good',
  tailoring: 'busy',
  cv_ready: 'good',
  filling: 'busy',
  form_filled: 'warn',
  applied: 'good',
  skipped: 'neutral',
  failed: 'bad',
};

export const leadStatusLabel = (status: LeadStatus) =>
  status === 'cv_ready' ? 'CV ready' : humanize(status);

export function LeadStatusPill({ status }: { status: LeadStatus }) {
  return (
    <span className="pill" data-tone={LEAD_TONE[status]}>
      {leadStatusLabel(status)}
    </span>
  );
}

export function RunStatusPill({ status }: { status: Run['status'] }) {
  return (
    <span className="pill" data-tone={status === 'running' ? 'busy' : 'good'}>
      {humanize(status)}
    </span>
  );
}

const scoreBand = (score: number) => (score >= 75 ? 'high' : score >= 50 ? 'mid' : 'low');

export function ScoreBadge({ score, large = false }: { score: number | null; large?: boolean }) {
  const size = large ? 'score score--lg' : 'score';
  if (score === null) {
    return (
      <span className={size} title="Not scored yet">
        —
      </span>
    );
  }
  return (
    <span className={size} data-band={scoreBand(score)} title={`Fit score ${score} of 100`}>
      {score}
    </span>
  );
}
