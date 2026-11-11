import { formatSalary, humanize } from '@/lib/format';
import type { Lead } from '@/lib/types';

interface Tile {
  label: string;
  /** '' when the posting does not say. */
  value: string;
}

/** humanize() renders unknown as a dash; a tile wants '' so it can say "Not stated". */
const known = (value: string) => (value && value !== 'unknown' ? humanize(value) : '');

/** The extractor's reading, else the lead's column, else the board's own remote flag. */
const remotePolicy = (lead: Lead) =>
  known(lead.extracted?.remote_policy ?? '') ||
  known(lead.remote_policy) ||
  (lead.job.remote === true ? 'Remote' : '');

function tiles(lead: Lead): Tile[] {
  const facts = lead.extracted;
  const salary = facts
    ? formatSalary(facts.salary_min, facts.salary_max, facts.salary_currency)
    : '';
  const experience = facts?.years_experience;
  return [
    { label: 'Salary', value: salary || lead.job.salary },
    { label: 'Remote policy', value: remotePolicy(lead) },
    { label: 'Location', value: facts?.locations.join(', ') || lead.location },
    { label: 'Seniority', value: known(facts?.seniority ?? lead.seniority) },
    { label: 'Contract', value: known(facts?.contract_type ?? '') },
    { label: 'Experience', value: experience != null ? `${experience}+ years` : '' },
  ];
}

/** The six facts people check first, as tiles; the ones the posting states come first. */
export function AtAGlance({ lead }: { lead: Lead }) {
  const all = tiles(lead);
  const ordered = [...all.filter((tile) => tile.value), ...all.filter((tile) => !tile.value)];
  return (
    <dl
      aria-label="At a glance"
      className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
    >
      {ordered.map(({ label, value }) => (
        <div key={label} className="card !px-3 !py-2.5">
          <dt className="label">{label}</dt>
          {value ? (
            <dd className="mt-0.5 text-[0.9rem] leading-snug font-semibold text-fg">{value}</dd>
          ) : (
            <dd className="mt-0.5 text-[0.8rem] leading-snug text-faint">Not stated</dd>
          )}
        </div>
      ))}
    </dl>
  );
}
