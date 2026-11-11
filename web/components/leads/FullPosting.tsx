import { ChevronRight } from 'lucide-react';

/** Paragraphs are separated by blank lines; single line breaks inside one are kept. */
const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

/**
 * The raw posting text, closed by default: the cards above carry the important
 * points, this is for checking the wording. Plain text only, never HTML.
 */
export function FullPosting({ description }: { description: string }) {
  if (!description) {
    return (
      <section className="card">
        <p className="text-[0.84rem] text-muted">The source gave no description of this job.</p>
      </section>
    );
  }
  return (
    <details className="card group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.84rem] font-semibold text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight size={16} className="group-open:rotate-90" aria-hidden="true" />
        <span className="group-open:hidden">Show full posting</span>
        <span className="hidden group-open:inline">Hide full posting</span>
      </summary>
      <div className="mt-3 grid max-w-prose gap-3 text-[0.86rem] leading-relaxed text-body">
        {paragraphs(description).map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </div>
    </details>
  );
}
