'use client';
import { useState } from 'react';
import { type ApiError, api, toApiError } from '@/lib/api';
import type { Lead, LeadStatus } from '@/lib/types';
import { ConfirmButton } from '@/components/ui/ConfirmDialog';
import { InlineError } from '@/components/ui/States';
import { ApplicationFiles } from './ApplicationFiles';
import {
  ApplicationStatus,
  FilledFields,
  SessionCost,
  UnansweredQuestions,
} from './ApplicationStatus';

/** Statuses in which the applier is working and the page polls for the outcome. */
export const isApplierBusy = (status: LeadStatus) => status === 'tailoring' || status === 'filling';

const CAN_SKIP: LeadStatus[] = ['new', 'scored', 'researched', 'cv_ready', 'form_filled', 'failed'];
const CAN_TAILOR: LeadStatus[] = ['new', 'scored', 'researched', 'failed'];
const CAN_FILL_FORM: LeadStatus[] = ['cv_ready', 'form_filled'];
/** Statuses that say so when the application folder is empty. */
const EXPECTS_FILES: LeadStatus[] = ['cv_ready', 'form_filled', 'applied'];

function TailorButton({
  again,
  busy,
  onTailor,
}: {
  again: boolean;
  busy: boolean;
  onTailor: () => void;
}) {
  return (
    <>
      <button type="button" className="btn btn--primary" disabled={busy} onClick={onTailor}>
        {again ? 'Tailor CV again' : 'Tailor CV'}
      </button>
      <p className="text-[0.76rem] leading-snug text-muted">
        Runs Claude Code with the polishmycv skill to write a CV for this posting.
      </p>
    </>
  );
}

/** The way out when the applier stopped without reporting back (killed, laptop asleep). */
function StuckReset({ busy, onReset }: { busy: boolean; onReset: () => void }) {
  return (
    <ConfirmButton
      label="Stuck? Reset this lead"
      className="btn btn--quiet"
      disabled={busy}
      title="Reset this lead?"
      confirmLabel="Reset lead"
      onConfirm={onReset}
    >
      <p>Use this when the applier was stopped or crashed and the lead has not moved since.</p>
      <p>
        The lead goes back to where it was: CV ready if tailored files exist, else ready to tailor.
      </p>
      <p className="font-semibold text-fg">
        The applier may still be running. If it is, it can still finish and change the lead, and a
        browser window may stay open on the applier machine.
      </p>
    </ConfirmButton>
  );
}

function FillFormButton({ lead, busy, onFill }: { lead: Lead; busy: boolean; onFill: () => void }) {
  const first = lead.status === 'cv_ready' && !lead.application?.error;
  return (
    <ConfirmButton
      label={first ? 'Fill application form' : 'Fill the form again'}
      className={lead.status === 'cv_ready' ? 'btn btn--primary' : 'btn'}
      disabled={busy}
      title="Fill the application form?"
      confirmLabel="Open browser and fill"
      onConfirm={onFill}
    >
      <p>A browser window opens on the machine running the applier.</p>
      <p>The form is filled with your details and the tailored CV.</p>
      <p className="font-semibold text-fg">
        It stops before Submit. You review the form and submit it yourself.
      </p>
    </ConfirmButton>
  );
}

/**
 * The human-gated part of the pipeline for one lead. Each lead status maps to
 * one step: tailor the CV, review the files, let the applier fill the form,
 * submit it yourself, mark it applied.
 */
export function ApplicationPanel({ lead, onLead }: { lead: Lead; onLead: (lead: Lead) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { status, application, job_id: jobId } = lead;
  const hasFiles = !!application?.files.length;
  const canMarkApplied = CAN_FILL_FORM.includes(status) || (status === 'failed' && hasFiles);

  const act = async (request: () => Promise<Lead>) => {
    setBusy(true);
    setError(null);
    try {
      onLead(await request());
    } catch (reason) {
      setError(toApiError(reason));
    } finally {
      setBusy(false);
    }
  };
  const changeStatus = (next: 'new' | 'skipped' | 'applied') =>
    act(() => api.setLeadStatus(jobId, next));

  return (
    <section className="card grid gap-3" aria-label="Application">
      <h2 className="card__title !mb-0">Application</h2>
      <ApplicationStatus lead={lead} />
      {isApplierBusy(status) && <StuckReset busy={busy} onReset={() => changeStatus('new')} />}

      {status === 'form_filled' && (
        <>
          <FilledFields fields={application?.filled_fields ?? []} />
          <UnansweredQuestions questions={application?.unanswered ?? []} />
        </>
      )}
      {application && (hasFiles || EXPECTS_FILES.includes(status)) && (
        <ApplicationFiles jobId={jobId} files={application.files} />
      )}
      {application?.cost_usd != null && <SessionCost usd={application.cost_usd} />}

      {CAN_TAILOR.includes(status) && (
        <TailorButton
          again={status === 'failed'}
          busy={busy}
          onTailor={() => act(() => api.tailor(jobId))}
        />
      )}
      {CAN_FILL_FORM.includes(status) && (
        <FillFormButton lead={lead} busy={busy} onFill={() => act(() => api.apply(jobId))} />
      )}
      {canMarkApplied && (
        <button
          type="button"
          className={status === 'form_filled' ? 'btn btn--primary' : 'btn'}
          disabled={busy}
          onClick={() => changeStatus('applied')}
        >
          Mark as applied
        </button>
      )}
      {CAN_SKIP.includes(status) && (
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy}
          onClick={() => changeStatus('skipped')}
        >
          Skip this lead
        </button>
      )}
      {status === 'skipped' && (
        <button type="button" className="btn" disabled={busy} onClick={() => changeStatus('new')}>
          Restore
        </button>
      )}
      <InlineError error={error} />
    </section>
  );
}
