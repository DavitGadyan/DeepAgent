import type { FitScore } from '@/lib/types';
import { ScoreBadge } from '@/components/ui/badges';
import { Card, Chips } from './parts';

/** The scorer's rubric: the four parts add up to 100. */
const RUBRIC = [
  { key: 'skills', label: 'Skills', max: 45 },
  { key: 'role', label: 'Role', max: 25 },
  { key: 'seniority', label: 'Seniority', max: 15 },
  { key: 'logistics', label: 'Logistics', max: 15 },
];

/** Four small meters, one per rubric part; nothing when the score carries no breakdown. */
function Breakdown({ breakdown }: { breakdown: Record<string, number> | undefined }) {
  const parts = RUBRIC.filter((part) => typeof breakdown?.[part.key] === 'number');
  if (parts.length === 0) return null;
  return (
    <ul className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
      {parts.map(({ key, label, max }) => {
        const points = Math.max(0, Math.min(max, breakdown?.[key] ?? 0));
        return (
          <li key={key}>
            <p className="flex items-baseline justify-between text-[0.76rem] text-muted">
              {label}
              <span className="font-semibold text-fg tabular-nums">
                {points}
                <span className="font-normal text-muted">/{max}</span>
              </span>
            </p>
            <div
              className="meter"
              role="meter"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={max}
              aria-valuenow={points}
            >
              <i style={{ width: `${(points / max) * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function FitPanel({ fit, failure }: { fit: FitScore | null; failure?: string }) {
  if (!fit) {
    return <Card title="Fit" note="The scorer has not rated this posting yet." failure={failure} />;
  }
  return (
    <Card title="Fit" failure={failure}>
      <div className="flex items-start gap-4">
        <ScoreBadge score={fit.score} large />
        <p className="max-w-prose text-[0.86rem] leading-relaxed text-body">{fit.rationale}</p>
      </div>
      <Breakdown breakdown={fit.breakdown} />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="label mb-1.5">Matched skills</h3>
          <Chips items={fit.matched_skills} tone="good" />
        </div>
        <div>
          <h3 className="label mb-1.5">Missing skills</h3>
          <Chips items={fit.missing_skills} tone="warn" />
        </div>
      </div>
      {fit.concerns.length > 0 && (
        <div className="mt-4">
          <h3 className="label mb-1.5">Concerns</h3>
          <ul className="list-disc space-y-1 pl-5 text-[0.84rem] leading-relaxed text-body">
            {fit.concerns.map((concern) => (
              <li key={concern}>{concern}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
