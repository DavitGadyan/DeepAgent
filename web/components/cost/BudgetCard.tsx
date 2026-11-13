'use client';
import { Check, CircleAlert, TriangleAlert } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { type ApiError, api, toApiError } from '@/lib/api';
import { type BudgetStatus, budgetStatus } from '@/lib/cost';
import { formatUsd } from '@/lib/format';
import type { Settings } from '@/lib/types';
import { InlineError } from '@/components/ui/States';

type BudgetField = 'monthly_budget_usd' | 'tailor_budget_usd' | 'fill_budget_usd';

function UsdField({
  label,
  hint,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="grid content-start gap-1">
      <span className="label">{label}</span>
      <input
        type="number"
        className="field w-32"
        min={0}
        max={max}
        step={step}
        required
        value={value}
        onChange={(change) => onChange(Number(change.target.value))}
      />
      <span className="text-[0.76rem] text-muted">{hint}</span>
    </label>
  );
}

/** What the state of the month means, in words: the bar's colour never says it alone. */
function BudgetNote({ status }: { status: BudgetStatus }) {
  if (status.level === 'over') {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-[0.8rem] leading-snug text-danger">
        <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        The monthly budget is used up. Tailor CV and Apply are refused until you raise it (or set 0
        for no limit).
      </p>
    );
  }
  if (status.level === 'near') {
    return (
      <p role="status" className="flex items-start gap-1.5 text-[0.8rem] leading-snug text-warn">
        <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        {status.percent} % of the monthly budget is used: {formatUsd(status.leftUsd)} left. At 100 %
        Tailor CV and Apply are refused.
      </p>
    );
  }
  return (
    <p className="text-[0.8rem] text-muted">
      {status.percent} % used, {formatUsd(status.leftUsd)} left this month.
    </p>
  );
}

/** This month's spend against the saved budget. */
function MonthMeter({ spentUsd, budgetUsd }: { spentUsd: number; budgetUsd: number }) {
  const status = budgetStatus(spentUsd, budgetUsd);
  if (status.level === 'none') {
    return (
      <p className="text-[0.8rem] text-muted">
        No monthly limit. Spent this month: {formatUsd(spentUsd)}.
      </p>
    );
  }
  return (
    <div className="grid gap-1.5">
      <p className="text-[0.84rem] text-body">
        <span className="font-semibold text-fg">{formatUsd(spentUsd)}</span> of{' '}
        {formatUsd(budgetUsd)} spent this month
      </p>
      <div
        className="meter meter--budget"
        data-level={status.level}
        role="meter"
        aria-label="This month's spend against the monthly budget"
        aria-valuemin={0}
        aria-valuemax={budgetUsd}
        aria-valuenow={Math.min(spentUsd, budgetUsd)}
        aria-valuetext={`${formatUsd(spentUsd)} of ${formatUsd(budgetUsd)}`}
      >
        <i style={{ width: `${Math.min(100, status.percent)}%` }} />
      </div>
      <BudgetNote status={status} />
    </div>
  );
}

/**
 * The monthly budget with this month's spend against it, and the caps on one
 * session. Saving sends the whole settings object, as Setup does; only the
 * three budget fields are edited here.
 */
export function BudgetCard({
  settings,
  spentUsd,
  onSaved,
}: {
  settings: Settings;
  /** This month's spend. */
  spentUsd: number;
  onSaved: (settings: Settings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = (field: BudgetField) => (value: number) =>
    setDraft((prev) => ({ ...prev, [field]: value }));

  const save = async (submit: FormEvent) => {
    submit.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.saveSettings(draft));
    } catch (reason) {
      setError(toApiError(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card grid gap-4" onSubmit={save}>
      <h2 className="card__title !mb-0">Budget</h2>
      <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start sm:gap-8">
        <UsdField
          label="Monthly budget (USD)"
          hint="0 means no limit."
          max={100_000}
          step={1}
          value={draft.monthly_budget_usd}
          onChange={set('monthly_budget_usd')}
        />
        <MonthMeter spentUsd={spentUsd} budgetUsd={settings.monthly_budget_usd} />
      </div>

      <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <UsdField
          label="Tailor CV budget (USD)"
          hint="The most one Tailor CV session may spend."
          max={200}
          step={0.5}
          value={draft.tailor_budget_usd}
          onChange={set('tailor_budget_usd')}
        />
        <UsdField
          label="Fill form budget (USD)"
          hint="The most one form-filling session may spend."
          max={200}
          step={0.5}
          value={draft.fill_budget_usd}
          onChange={set('fill_budget_usd')}
        />
      </div>
      <p className="text-[0.76rem] text-muted">
        The two caps stop a single Claude Code session; 0 means no cap. With Claude login, the cost
        is what the session would cost at API prices and counts against your plan&apos;s usage.
      </p>

      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save budgets'}
        </button>
        {!dirty && !saving && (
          <span role="status" className="flex items-center gap-1 text-[0.78rem] text-muted">
            <Check size={14} className="text-accent" aria-hidden="true" />
            No unsaved changes
          </span>
        )}
        <InlineError error={error} />
      </div>
    </form>
  );
}
