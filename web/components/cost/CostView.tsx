'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { ErrorBanner, ErrorState, Loading } from '@/components/ui/States';
import { Breakdowns } from './Breakdowns';
import { BudgetCard } from './BudgetCard';
import { CostLinks } from './CostLinks';
import { DailySpend, type RangeDays } from './DailySpend';
import { SpendTiles } from './SpendTiles';

/**
 * The Cost page: the budgets, what the Claude Code sessions (Tailor CV, Apply)
 * have cost, and links to what only Anthropic and Langfuse know. Spend only:
 * there is no API for the remaining credit balance.
 */
export function CostView() {
  const [range, setRange] = useState<RangeDays>(30);
  const report = useApi(`costs:${range}`, () => api.costs(range));
  const settings = useApi('settings', api.settings);

  const error = report.error ?? settings.error;
  const retry = () => {
    report.reload();
    settings.reload();
  };
  if (error && (!report.data || !settings.data)) {
    return <ErrorState error={error} onRetry={retry} />;
  }
  if (!report.data || !settings.data) return <Loading label="Loading costs…" />;

  return (
    <div className="mx-auto grid max-w-5xl gap-3 p-4">
      <PageHeader
        title="Cost"
        detail="What Tailor CV and Apply cost in Claude Code sessions. The pipeline agents run on your own models."
      />
      {/* A failed reload keeps the last figures on screen, labelled. */}
      {report.error && (
        <ErrorBanner error={report.error} onRetry={report.reload}>
          The figures below are from the last report that loaded.
        </ErrorBanner>
      )}
      <BudgetCard
        key={JSON.stringify(settings.data)}
        settings={settings.data}
        spentUsd={report.data.this_month.usd}
        onSaved={settings.mutate}
      />
      <SpendTiles report={report.data} />
      <DailySpend
        days={report.data.by_day}
        range={range}
        loading={report.loading}
        onRange={setRange}
      />
      <Breakdowns report={report.data} />
      <CostLinks links={report.data.links} />
    </div>
  );
}
