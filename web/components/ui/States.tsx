import { CircleAlert, Inbox, LoaderCircle, RotateCw, ServerOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ApiError } from '@/lib/api';

function Frame({ children, role }: { children: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div
      role={role}
      className="grid place-items-center gap-3 px-6 py-14 text-center text-muted [&>svg]:mx-auto"
    >
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <Frame role="status">
      <LoaderCircle size={20} className="spin" aria-hidden="true" />
      <p>{label}</p>
    </Frame>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Frame>
      <Inbox size={22} aria-hidden="true" />
      <p className="font-semibold text-body">{title}</p>
      {children && <div className="max-w-md text-[0.8rem] leading-relaxed">{children}</div>}
    </Frame>
  );
}

/** A failed request: says whether the orchestrator is down or answered with an error. */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const Icon = error.unreachable ? ServerOff : CircleAlert;
  return (
    <Frame role="alert">
      <Icon size={22} className="text-danger" aria-hidden="true" />
      <p className="font-semibold text-body">{error.message}</p>
      <p className="max-w-md text-[0.8rem] leading-relaxed">
        {error.unreachable
          ? 'Check that the orchestrator is running, then try again.'
          : `The orchestrator answered with an error (HTTP ${error.status}).`}
      </p>
      <button type="button" className="btn" onClick={onRetry}>
        <RotateCw size={14} aria-hidden="true" />
        Retry
      </button>
    </Frame>
  );
}

/**
 * A failed request above content that is still on screen from an earlier
 * load; `children` says what that content is.
 */
export function ErrorBanner({
  error,
  onRetry,
  children,
}: {
  error: ApiError;
  onRetry: () => void;
  children: ReactNode;
}) {
  const Icon = error.unreachable ? ServerOff : CircleAlert;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-[0.8rem] leading-snug"
    >
      <Icon size={16} className="shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-body">{error.message}</p>
        <p className="text-muted">{children}</p>
      </div>
      <button type="button" className="btn" onClick={onRetry}>
        <RotateCw size={14} aria-hidden="true" />
        Retry
      </button>
    </div>
  );
}

/** One-line error for a failed action (button press) inside an otherwise working page. */
export function InlineError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[0.78rem] leading-snug text-danger">
      <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      {error.message}
    </p>
  );
}
