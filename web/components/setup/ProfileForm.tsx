'use client';
import { Check } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { type ApiError, api, toApiError } from '@/lib/api';
import { PROFILE_GROUPS, answered } from '@/lib/profileFields';
import type { UserProfile } from '@/lib/types';
import { InlineError } from '@/components/ui/States';

/**
 * Your profile (`data/profile/profile.yaml`). Saved separately from the settings:
 * the scorer and the applier read the file again on their next job.
 */
export function ProfileForm({
  initial,
  onSaved,
}: {
  initial: UserProfile;
  onSaved: (profile: UserProfile) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const set = (section: keyof UserProfile, key: string, value: string) =>
    setDraft((prev) => ({ ...prev, [section]: { ...prev[section], [key]: value } }));

  const save = async (submit: FormEvent) => {
    submit.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.saveProfile(draft));
    } catch (reason) {
      setError(toApiError(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="grid gap-3" onSubmit={save} aria-label="Your profile">
      {PROFILE_GROUPS.map((group) => (
        <section key={group.title} className="card grid gap-3">
          <header className="flex items-baseline justify-between gap-3">
            <h2 className="card__title !mb-0">{group.title}</h2>
            <span className="text-[0.72rem] text-muted tabular-nums">
              {answered(draft, group)} of {group.fields.length} filled
            </span>
          </header>
          <p className="text-[0.76rem] text-muted">{group.hint}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.fields.map((field) => (
              <label key={field.key} className="grid content-start gap-1">
                <span className="label">{field.label}</span>
                <input
                  type={field.type ?? 'text'}
                  className="field"
                  maxLength={500}
                  autoComplete="off"
                  placeholder={field.example ? `e.g. ${field.example}` : ''}
                  value={draft[group.section][field.key] ?? ''}
                  onChange={(change) => set(group.section, field.key, change.target.value)}
                />
              </label>
            ))}
          </div>
        </section>
      ))}

      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        {!dirty && !saving && (
          <span role="status" className="flex items-center gap-1 text-[0.78rem] text-muted">
            <Check size={14} className="text-accent" aria-hidden="true" />
            Saved to data/profile/profile.yaml
          </span>
        )}
        <InlineError error={error} />
      </div>
    </form>
  );
}
