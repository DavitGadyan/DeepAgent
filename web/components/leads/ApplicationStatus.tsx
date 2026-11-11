import { CircleCheck, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatUsd } from '@/lib/format';
import type { Lead } from '@/lib/types';

function Progress({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2 text-[0.84rem] leading-relaxed">
      <LoaderCircle size={16} className="spin mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** A form fill that did not finish leaves the lead in cv_ready with the reason. */
function UnfinishedFill({ error }: { error: string }) {
  return (
    <div role="alert" className="grid gap-1 text-[0.84rem] leading-relaxed">
      <p className="text-warn">The last form-fill attempt did not finish: {error}</p>
      <p className="text-[0.78rem] text-muted">
        If it stopped at a login or CAPTCHA, get past it in the open browser window first. Then fill
        the form again, or apply by hand with the files below.
      </p>
    </div>
  );
}

/** One line on where the application stands, for the lead's status. */
export function ApplicationStatus({ lead }: { lead: Lead }) {
  const error = lead.application?.error ?? '';
  switch (lead.status) {
    case 'failed':
      return (
        <p role="alert" className="text-[0.84rem] leading-relaxed text-danger">
          {error || 'The applier failed without reporting an error.'}
        </p>
      );
    case 'cv_ready':
      return error ? <UnfinishedFill error={error} /> : null;
    case 'tailoring':
      return <Progress>Tailoring your CV to this posting. This can take a few minutes.</Progress>;
    case 'filling':
      return (
        <Progress>
          Filling the application form in a browser on the applier machine. It stops before Submit.
        </Progress>
      );
    case 'form_filled':
      return (
        <p className="text-[0.84rem] leading-relaxed text-warn">
          Waiting for you to review and submit in the browser.
        </p>
      );
    case 'applied':
      return (
        <p className="flex items-center gap-2 text-[0.84rem] font-semibold text-fg">
          <CircleCheck size={16} className="text-accent" aria-hidden="true" />
          Applied
        </p>
      );
    case 'skipped':
      return <p className="text-[0.84rem] text-muted">You skipped this lead.</p>;
    default:
      return null;
  }
}

/** Form questions the applier could not answer from your profile. */
export function UnansweredQuestions({ questions }: { questions: string[] }) {
  if (questions.length === 0) return null;
  return (
    <div>
      <h3 className="label mb-1.5">Questions left for you</h3>
      <ul className="list-disc space-y-1 pl-5 text-[0.82rem] leading-relaxed">
        {questions.map((question) => (
          <li key={question}>{question}</li>
        ))}
      </ul>
    </div>
  );
}

/** Longer lists start collapsed so the next action stays in view. */
const FIELDS_SHOWN_OPEN = 6;

/** Form fields the applier filled, for the review before Submit. */
export function FilledFields({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null;
  const list = (
    <ul className="list-disc space-y-1 pl-5 text-[0.82rem] leading-relaxed">
      {fields.map((field) => (
        <li key={field}>{field}</li>
      ))}
    </ul>
  );
  if (fields.length <= FIELDS_SHOWN_OPEN) {
    return (
      <div>
        <h3 className="label mb-1.5">Filled by the agent</h3>
        {list}
      </div>
    );
  }
  return (
    <details>
      <summary className="label mb-1.5 cursor-pointer">
        Filled by the agent ({fields.length})
      </summary>
      {list}
    </details>
  );
}

/** What Claude Code's sessions for this lead cost, as Claude Code reports it. */
export function SessionCost({ usd }: { usd: number }) {
  return (
    <p className="text-[0.76rem] leading-snug text-muted">
      Claude Code sessions for this lead: {formatUsd(usd)} at API prices
    </p>
  );
}
