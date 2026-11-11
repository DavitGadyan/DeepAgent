import type { ExtractedJob } from '@/lib/types';
import { Card, Chips } from './parts';

function BulletGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="label mb-1.5">{title}</h3>
      <ul className="list-disc space-y-1 pl-4 text-[0.84rem] leading-snug text-body marker:text-faint">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the job is, as the extractor read it: one line on the company, a short
 * lead-in, then up to three bullet groups side by side and the skill chips.
 * Leads extracted before the bullet fields existed simply show fewer parts.
 */
export function RolePanel({ facts, failure }: { facts: ExtractedJob | null; failure?: string }) {
  if (!facts) {
    return (
      <Card
        title="The role"
        note="The extractor has not read this posting yet."
        failure={failure}
      />
    );
  }

  const groups = [
    { title: "What you'll do", items: facts.responsibilities ?? [] },
    { title: 'What they need', items: facts.requirements ?? [] },
    { title: 'What you get', items: facts.benefits ?? [] },
  ].filter((group) => group.items.length > 0);

  return (
    <Card title="The role" failure={failure}>
      {facts.company_one_liner && (
        <p className="max-w-prose text-[0.9rem] leading-relaxed font-semibold text-fg">
          {facts.company_one_liner}
        </p>
      )}
      {facts.summary && (
        <p className="mt-1 max-w-prose text-[0.86rem] leading-relaxed text-body">{facts.summary}</p>
      )}
      {groups.length > 0 && (
        <div className="mt-4 grid gap-x-6 gap-y-4 md:grid-cols-3">
          {groups.map((group) => (
            <BulletGroup key={group.title} {...group} />
          ))}
        </div>
      )}
      <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <div>
          <h3 className="label mb-1.5">Required skills</h3>
          <Chips items={facts.required_skills} />
        </div>
        <div>
          <h3 className="label mb-1.5">Nice to have</h3>
          <Chips items={facts.nice_to_have_skills} />
        </div>
      </div>
    </Card>
  );
}
