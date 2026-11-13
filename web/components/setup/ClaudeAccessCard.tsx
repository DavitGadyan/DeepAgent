'use client';
import { CircleAlert, CircleCheck, KeyRound, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { checkAccess } from '@/lib/claudeAccess';
import { CUSTOM_MODEL, MODEL_CHOICES, isModelName, modelChoice } from '@/lib/models';
import type { ClaudeAccess, Settings } from '@/lib/types';
import { useApi } from '@/lib/useApi';

// The applier re-checks `.env` every 10 s, so a key added there shows within ~20 s.
const STATUS_POLL_MS = 10_000;

const SIDES: Record<ClaudeAccess, { label: string; detail: string }> = {
  login: { label: 'Claude login', detail: 'Your Claude account (subscription)' },
  console: { label: 'Console API key', detail: 'ANTHROPIC_API_KEY, billed per token' },
};

/** How the applier's Claude Code sessions sign in and which model tailors the CV. */
export function ClaudeAccessCard({
  value,
  onChange,
}: {
  value: Settings;
  onChange: <K extends keyof Settings>(key: K, next: Settings[K]) => void;
}) {
  const status = useApi('applier-status', api.applierStatus);
  const { refresh } = status;
  useEffect(() => {
    const timer = setInterval(refresh, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const access = value.claude_access;
  const console_ = access === 'console';
  const check = status.data === undefined ? null : checkAccess(access, status.data);
  const flip = () => onChange('claude_access', console_ ? 'login' : 'console');

  return (
    <section className="card grid gap-4">
      <h2 className="card__title !mb-0">Claude Code access (Tailor CV and Apply)</h2>

      <div className="flex flex-wrap items-center gap-3">
        <SideLabel
          side="login"
          active={!console_}
          onClick={() => onChange('claude_access', 'login')}
        />
        <button
          type="button"
          role="switch"
          aria-checked={console_}
          aria-label="Use a Console API key instead of Claude login"
          className="switch"
          onClick={flip}
        >
          <span className="switch__knob" aria-hidden="true" />
        </button>
        <SideLabel
          side="console"
          active={console_}
          onClick={() => onChange('claude_access', 'console')}
        />
      </div>

      {check && (
        <p
          role="status"
          className={`flex items-center gap-1.5 text-[0.78rem] ${check.ok ? 'text-soft' : 'text-danger'}`}
        >
          {check.ok ? (
            <CircleCheck size={14} className="text-accent" aria-hidden="true" />
          ) : (
            <CircleAlert size={14} aria-hidden="true" />
          )}
          {check.message}
        </p>
      )}

      <TailorModel value={value.tailor_model} onChange={(next) => onChange('tailor_model', next)} />

      <p className="text-[0.76rem] text-muted">
        Budgets are on the{' '}
        <Link href="/cost" className="font-semibold text-fg underline">
          Cost page
        </Link>
        : the monthly budget and what one session may spend.
      </p>
    </section>
  );
}

/** A listed alias, or any full model name typed in. */
function TailorModel({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [custom, setCustom] = useState(modelChoice(value) === CUSTOM_MODEL);
  const valid = isModelName(value);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid content-start gap-1">
        <span className="label">Tailor CV model</span>
        <select
          className="field"
          value={custom ? CUSTOM_MODEL : value}
          onChange={(change) => {
            const next = change.target.value;
            setCustom(next === CUSTOM_MODEL);
            onChange(next === CUSTOM_MODEL ? '' : next);
          }}
        >
          {MODEL_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
          <option value={CUSTOM_MODEL}>Other: full model name…</option>
        </select>
      </label>
      {custom && (
        <label className="grid content-start gap-1">
          <span className="label">Full model name</span>
          <input
            className="field font-mono"
            placeholder="e.g. claude-opus-5-5"
            maxLength={64}
            required
            pattern="[a-z][a-z0-9.\-]*(\[1m\])?"
            aria-invalid={!valid}
            value={value}
            onChange={(change) => onChange(change.target.value.trim())}
          />
          {!valid && (
            <span className="text-[0.74rem] text-danger">
              Lower-case letters, digits, dots and dashes, e.g. claude-opus-5-5.
            </span>
          )}
        </label>
      )}
    </div>
  );
}

function SideLabel({
  side,
  active,
  onClick,
}: {
  side: ClaudeAccess;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = side === 'login' ? UserRound : KeyRound;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-hidden="true"
      tabIndex={-1}
      className={`flex cursor-pointer items-center gap-2 text-left ${active ? 'text-fg' : 'text-muted'}`}
    >
      <Icon size={16} />
      <span className="grid">
        <span className="text-[0.84rem] font-semibold">{SIDES[side].label}</span>
        <span className="text-[0.72rem] text-muted">{SIDES[side].detail}</span>
      </span>
    </button>
  );
}
