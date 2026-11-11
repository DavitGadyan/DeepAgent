import type { ReactNode } from 'react';

/** Small building blocks shared by the lead detail cards. */

export function Chips({ items, tone }: { items: string[]; tone?: 'good' | 'warn' }) {
  if (items.length === 0) return <p className="text-[0.8rem] text-muted">None</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item} className="chip" data-tone={tone}>
          {item}
        </li>
      ))}
    </ul>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mt-0.5 text-[0.84rem] leading-relaxed text-body">{children || '—'}</dd>
    </div>
  );
}

/**
 * A titled card. `note` replaces the body when the pipeline has nothing to
 * show yet; `failure` says why a step failed and then replaces the note.
 */
export function Card({
  title,
  note,
  failure,
  children,
}: {
  title: string;
  note?: string;
  failure?: string;
  children?: ReactNode;
}) {
  return (
    <section className="card">
      <h2 className="card__title">{title}</h2>
      {failure && (
        <p role="alert" className="mb-2 text-[0.84rem] leading-relaxed text-danger">
          {failure}
        </p>
      )}
      {note && !failure ? (
        <p className="text-[0.84rem] leading-relaxed text-muted">{note}</p>
      ) : (
        children
      )}
    </section>
  );
}
