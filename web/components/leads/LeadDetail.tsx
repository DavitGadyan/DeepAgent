'use client';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { failureNote, formatDate } from '@/lib/format';
import { pipelineSources, sourceLabel } from '@/lib/sources';
import type { Lead, PipelineStage } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { LeadStatusPill } from '@/components/ui/badges';
import { ErrorBanner, ErrorState, Loading } from '@/components/ui/States';
import { ApplicationPanel, isApplierBusy } from './ApplicationPanel';
import { AtAGlance } from './AtAGlance';
import { BriefPanel } from './BriefPanel';
import { FitPanel } from './FitPanel';
import { FullPosting } from './FullPosting';
import { RolePanel } from './RolePanel';

/** How often the lead is re-read while the applier is working on it. */
const APPLIER_POLL_MS = 3000;

/** The failure note for the card fed by `stages`, if one of them failed on this lead. */
function failureIn(lead: Lead, stages: PipelineStage[]): string | undefined {
  const failed = lead.pipeline_error;
  return failed && stages.includes(failed.agent) ? failureNote(failed) : undefined;
}

function LeadHeader({ lead, source }: { lead: Lead; source: string }) {
  return (
    <header className="mb-4">
      <Link
        href="/leads"
        className="inline-flex items-center gap-1 text-[0.78rem] text-muted hover:text-fg"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Leads
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-bold text-fg">{lead.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.84rem] text-soft">
            <span className="font-semibold text-fg">{lead.company}</span>
            {lead.location && <span>{lead.location}</span>}
            <span>Posted {formatDate(lead.posted_at)}</span>
            <span>via {source}</span>
            <LeadStatusPill status={lead.status} />
          </p>
        </div>
        <a href={lead.url} target="_blank" rel="noreferrer" className="btn">
          Original posting
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    </header>
  );
}

/** The Lead page: everything the pipeline learned about one posting, and the application steps. */
export function LeadDetail({ jobId }: { jobId: string }) {
  const lead = useApi(`lead:${jobId}`, () => api.lead(jobId));
  const pipeline = useApi('pipeline', api.pipeline);
  const busy = lead.data ? isApplierBusy(lead.data.status) : false;
  const refresh = lead.refresh;

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(refresh, APPLIER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, refresh]);

  if (lead.error && !lead.data) return <ErrorState error={lead.error} onRetry={lead.reload} />;
  if (!lead.data) return <Loading label="Loading the lead…" />;

  const data = lead.data;
  return (
    <div className="mx-auto max-w-6xl p-4">
      {lead.error && (
        <div className="mb-3">
          <ErrorBanner error={lead.error} onRetry={refresh}>
            {busy
              ? 'Showing the last state that loaded. The page keeps checking every few seconds.'
              : 'Showing the last state that loaded; it may be out of date.'}
          </ErrorBanner>
        </div>
      )}
      <LeadHeader lead={data} source={sourceLabel(pipelineSources(pipeline.data), data.source)} />
      <AtAGlance lead={data} />
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid gap-3">
          <FitPanel fit={data.score_detail} failure={failureIn(data, ['scorer'])} />
          {/* Nothing past the filter exists when it failed, so the role card says why. */}
          <RolePanel facts={data.extracted} failure={failureIn(data, ['filter', 'extractor'])} />
          <BriefPanel brief={data.brief} failure={failureIn(data, ['researcher'])} />
          <FullPosting description={data.job.description} />
        </div>
        {/* Sticky so the next action stays reachable; scrolls on its own if taller than the window. */}
        <div className="lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
          <ApplicationPanel lead={data} onLead={lead.mutate} />
        </div>
      </div>
    </div>
  );
}
