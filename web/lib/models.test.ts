import { describe, expect, it } from 'vitest';
import { CUSTOM_MODEL, isModelName, modelChoice } from './models';

describe('tailor model', () => {
  it('shows listed aliases as themselves and anything else as custom', () => {
    expect(modelChoice('')).toBe('');
    expect(modelChoice('opus')).toBe('opus');
    expect(modelChoice('claude-opus-5-5')).toBe(CUSTOM_MODEL);
  });

  it('accepts what the API accepts', () => {
    expect(isModelName('claude-opus-5-5[1m]')).toBe(true);
    expect(isModelName('')).toBe(true);
    expect(isModelName('--dangerously-skip-permissions')).toBe(false);
    expect(isModelName('Opus')).toBe(false);
  });
});
