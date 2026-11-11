import { ExternalLink } from 'lucide-react';
import type { CompanyBrief } from '@/lib/types';
import { Card, Fact } from './parts';

/** Shows the host of a source URL; the full URL when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const NOT_RESEARCHED =
  'Not researched. The researcher only looks into postings that score at or above the research threshold in Setup.';

export function BriefPanel({ brief, failure }: { brief: CompanyBrief | null; failure?: string }) {
  if (!brief) return <Card title="Company brief" note={NOT_RESEARCHED} failure={failure} />;
  return (
    <Card title="Company brief" failure={failure}>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label="What they do">{brief.what_they_do}</Fact>
        <Fact label="Stage and funding">{brief.stage_and_funding}</Fact>
        <Fact label="AI stack">{brief.ai_stack}</Fact>
        <Fact label="Hiring contact">{brief.hiring_contact}</Fact>
      </dl>
      {brief.sources.length > 0 && (
        <div className="mt-4">
          <h3 className="label mb-1.5">Sources</h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem]">
            {brief.sources.map((url) => (
              <li key={url}>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-body underline decoration-line-strong hover:decoration-fg"
                >
                  {hostOf(url)}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
