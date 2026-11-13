import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CostReport } from '@/lib/types';

function Outside({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <a className="btn" href={href} target="_blank" rel="noreferrer">
        {label}
        <ExternalLink size={13} aria-hidden="true" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      <p className="min-w-56 flex-1 text-[0.8rem] leading-snug text-muted">{children}</p>
    </li>
  );
}

/** What this page cannot show, and where it is: the credit balance and per-call detail. */
export function CostLinks({ links }: { links: CostReport['links'] }) {
  return (
    <section className="card">
      <h2 className="card__title">Balance and detail</h2>
      <ul className="grid gap-3">
        {links.console_billing && (
          <Outside href={links.console_billing} label="Open Console billing">
            Your remaining credit balance is on the Console billing page. Anthropic offers no API
            for it, so this page shows what was spent, not what is left.
          </Outside>
        )}
        {links.langfuse && (
          <Outside href={links.langfuse} label="Open Langfuse">
            Per-call detail: every model call with its tokens and timing, including the local models
            of the pipeline agents.
          </Outside>
        )}
      </ul>
    </section>
  );
}
