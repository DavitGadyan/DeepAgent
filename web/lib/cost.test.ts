import { describe, expect, it } from 'vitest';
import { axisScale, budgetStatus, dayTotal, formatAxisUsd, labelledDays } from './cost';

describe('budgetStatus', () => {
  it('has no level without a budget', () => {
    expect(budgetStatus(12, 0)).toEqual({ level: 'none', percent: 0, leftUsd: 0 });
  });

  it('is ok below 80 %', () => {
    expect(budgetStatus(10, 50)).toEqual({ level: 'ok', percent: 20, leftUsd: 40 });
    expect(budgetStatus(0, 50).level).toBe('ok');
  });

  it('warns from 80 %', () => {
    expect(budgetStatus(40, 50)).toMatchObject({ level: 'near', percent: 80, leftUsd: 10 });
    expect(budgetStatus(39.99, 50).level).toBe('ok');
  });

  it('is over at and above 100 %, with nothing left', () => {
    expect(budgetStatus(50, 50)).toEqual({ level: 'over', percent: 100, leftUsd: 0 });
    expect(budgetStatus(63, 50)).toEqual({ level: 'over', percent: 126, leftUsd: 0 });
  });

  it('rounds the percentage down, so it reads 100 only when the budget is used up', () => {
    expect(budgetStatus(49.9, 50)).toMatchObject({ level: 'near', percent: 99 });
  });
});

describe('axisScale', () => {
  it('picks round steps that reach the peak', () => {
    expect(axisScale(3.7)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4], step: 1 });
    expect(axisScale(18)).toEqual({ max: 20, ticks: [0, 5, 10, 15, 20], step: 5 });
    expect(axisScale(9)).toEqual({ max: 10, ticks: [0, 2.5, 5, 7.5, 10], step: 2.5 });
  });

  it('handles amounts of a few cents without float noise', () => {
    expect(axisScale(0.12)).toEqual({ max: 0.15, ticks: [0, 0.05, 0.1, 0.15], step: 0.05 });
    expect(axisScale(0.3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it('does not add a tick above a peak that sits on one', () => {
    expect(axisScale(4).max).toBe(4);
    expect(axisScale(100).max).toBe(100);
  });

  it('never has a zero-height axis', () => {
    expect(axisScale(0)).toEqual({ max: 1, ticks: [0, 1], step: 1 });
    expect(axisScale(Number.NEGATIVE_INFINITY).max).toBe(1);
  });
});

describe('formatAxisUsd', () => {
  it('uses the decimals the step needs', () => {
    expect(formatAxisUsd(15, 5)).toBe('$15');
    expect(formatAxisUsd(0.15, 0.05)).toBe('$0.15');
    expect(formatAxisUsd(0.004, 0.001)).toBe('$0.004');
  });

  it('never writes a single decimal', () => {
    expect(formatAxisUsd(7.5, 2.5)).toBe('$7.50');
    expect(formatAxisUsd(0.2, 0.1)).toBe('$0.20');
  });
});

describe('labelledDays', () => {
  it('labels every day of a week', () => {
    expect(labelledDays(7)).toEqual(Array(7).fill(true));
  });

  it('labels about seven days of a longer range, always the last one', () => {
    const month = labelledDays(30);
    expect(month[29]).toBe(true);
    expect(month.filter(Boolean)).toHaveLength(6);
    const quarter = labelledDays(90);
    expect(quarter[89]).toBe(true);
    expect(quarter.filter(Boolean)).toHaveLength(7);
  });
});

describe('dayTotal', () => {
  it('adds login and console spend', () => {
    expect(dayTotal({ date: '2026-11-12', login_usd: 1.25, console_usd: 0.5 })).toBe(1.75);
  });
});
