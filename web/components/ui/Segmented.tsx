/** A small either/or switch: joined buttons, the chosen one pressed. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  /** What is being chosen, for screen readers. */
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="btn"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
