import { describe, expect, it } from 'vitest';
import { failureNote, formatLimitPerSource, formatSalary, formatUsd } from './format';

describe('formatSalary', () => {
  it('formats a range in thousands with the currency', () => {
    expect(formatSalary(70_000, 95_000, 'EUR')).toBe('EUR 70k–95k');
  });

  it('formats a single amount when only one bound is known or both are equal', () => {
    expect(formatSalary(null, 120_000, 'USD')).toBe('USD 120k');
    expect(formatSalary(80_000, null, '')).toBe('80k');
    expect(formatSalary(90_000, 90_000, 'GBP')).toBe('GBP 90k');
  });

  it('is empty when no amount is known', () => {
    expect(formatSalary(null, null, 'EUR')).toBe('');
  });

  it('is empty for amounts below 1000 instead of showing "0k"', () => {
    expect(formatSalary(45, 60, 'USD')).toBe('');
    expect(formatSalary(400, 90_000, 'USD')).toBe('');
    expect(formatSalary(0, null, 'EUR')).toBe('');
  });
});

describe('formatLimitPerSource', () => {
  it('shows the stored limit', () => {
    expect(formatLimitPerSource(50)).toBe('50 per source');
  });

  it('shows 0 as the Setup default', () => {
    expect(formatLimitPerSource(0)).toBe('Setup default');
  });
});

describe('formatUsd', () => {
  it('rounds to cents', () => {
    expect(formatUsd(1.249)).toBe('$1.25');
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('failureNote', () => {
  it('names the agent and says how it is retried', () => {
    expect(failureNote({ agent: 'extractor', error: 'Model returned invalid JSON.' })).toBe(
      "The extractor failed on this posting: Model returned invalid JSON. It is retried on the next run with 'force'.",
    );
  });

  it('adds the full stop the error lacks', () => {
    expect(failureNote({ agent: 'researcher', error: 'timeout' })).toBe(
      "The researcher failed on this posting: timeout. It is retried on the next run with 'force'.",
    );
  });
});
