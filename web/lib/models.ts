/** Choices for the Tailor CV model. Aliases follow the latest model of each family. */
export const MODEL_CHOICES = [
  { value: '', label: "Claude Code's default" },
  { value: 'opus', label: 'Opus: best writing, highest cost' },
  { value: 'sonnet', label: 'Sonnet: balanced' },
  { value: 'haiku', label: 'Haiku: fastest, lowest cost' },
  { value: 'fable', label: 'Fable' },
] as const;

export const CUSTOM_MODEL = 'custom';

/** What the select shows for a stored value: a listed choice, or "custom" for a full name. */
export const modelChoice = (model: string): string =>
  MODEL_CHOICES.some((choice) => choice.value === model) ? model : CUSTOM_MODEL;

/** Same rule as the API: lower-case, starts with a letter, an optional `[1m]` suffix. */
export const isModelName = (model: string): boolean =>
  /^([a-z][a-z0-9.-]*(\[1m\])?)?$/.test(model) && model.length <= 64;
