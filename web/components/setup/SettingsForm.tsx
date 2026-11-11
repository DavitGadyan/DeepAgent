'use client';
import { Check } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { type ApiError, api, toApiError } from '@/lib/api';
import { type SourceInfo, sourceLabel } from '@/lib/sources';
import type { Settings } from '@/lib/types';
import { InlineError } from '@/components/ui/States';
import { ChipEditor } from './ChipEditor';

/**
 * Editable copy of the settings. Nothing is sent until Save; `onSaved` hands
 * the orchestrator's answer back so the page shows what was actually stored.
 */
export function SettingsForm({
  initial,
  sources,
  onSaved,
}: {
  initial: Settings;
  sources: SourceInfo[];
  onSaved: (settings: Settings) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

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
    <form className="grid gap-3" onSubmit={save}>
      <section className="card">
        <h2 className="card__title">Sources</h2>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(draft.sources).map(([name, enabled]) => (
            <li key={name}>
              <label className="flex items-center gap-2 text-[0.84rem]">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(change) =>
                    set('sources', { ...draft.sources, [name]: change.target.checked })
                  }
                />
                {sourceLabel(sources, name)}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="card grid gap-5">
        <h2 className="card__title !mb-0">Targeting</h2>
        <ChipEditor
          label="Keywords"
          hint="Target role phrases. A posting must match one to pass the filter."
          values={draft.keywords}
          onChange={(values) => set('keywords', values)}
        />
        <ChipEditor
          label="Exclude keywords"
          hint="A posting that mentions one of these is dropped."
          values={draft.exclude_keywords}
          onChange={(values) => set('exclude_keywords', values)}
        />
      </section>

      <section className="card grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className="label">Research min score</span>
          <span className="flex items-center gap-3">
            <input
              type="range"
              className="flex-1"
              min={0}
              max={100}
              value={draft.research_min_score}
              onChange={(change) => set('research_min_score', Number(change.target.value))}
            />
            <output className="w-8 text-right font-semibold tabular-nums">
              {draft.research_min_score}
            </output>
          </span>
          <span className="text-[0.76rem] text-muted">
            Only postings scoring at least this are researched.
          </span>
        </label>
        <label className="grid content-start gap-1">
          <span className="label">Limit per source</span>
          <input
            type="number"
            className="field w-32"
            min={1}
            max={500}
            required
            value={draft.limit_per_source}
            onChange={(change) => set('limit_per_source', Number(change.target.value))}
          />
          <span className="text-[0.76rem] text-muted">
            Most postings a run takes from one source.
          </span>
        </label>
      </section>

      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save settings'}
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
