import type { ReactNode } from 'react';

/** Title row shared by the table and form pages. */
export function PageHeader({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-bold text-fg">{title}</h1>
        {detail && <p className="mt-0.5 text-[0.8rem] text-muted">{detail}</p>}
      </div>
      {children}
    </header>
  );
}
