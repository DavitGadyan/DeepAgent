'use client';
import { X } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';

/** A list of short phrases edited as chips: Enter or comma adds, the cross removes. */
export function ChipEditor({
  label,
  hint,
  values,
  onChange,
}: {
  label: string;
  hint: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const inputId = useId();

  const add = () => {
    const phrase = draft.trim();
    const known = values.some((value) => value.toLowerCase() === phrase.toLowerCase());
    if (phrase && !known) onChange([...values, phrase]);
    setDraft('');
  };

  const onKeyDown = (key: KeyboardEvent<HTMLInputElement>) => {
    if (key.key === 'Enter' || key.key === ',') {
      key.preventDefault();
      add();
    } else if (key.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div>
      <label htmlFor={inputId} className="label">
        {label}
      </label>
      <p className="mt-0.5 mb-2 text-[0.76rem] text-muted">{hint}</p>
      <ul className="mb-2 flex flex-wrap gap-1.5">
        {values.map((value) => (
          <li key={value} className="chip">
            {value}
            <button
              type="button"
              className="-mr-1 grid size-4 place-items-center rounded-full hover:bg-hover"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((other) => other !== value))}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <input
        id={inputId}
        className="field w-full max-w-sm"
        placeholder="Type a phrase and press Enter"
        value={draft}
        onChange={(change) => setDraft(change.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
    </div>
  );
}
