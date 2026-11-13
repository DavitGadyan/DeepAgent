/** Figures for the Cost page: the monthly budget's state and the daily chart's scale. */
import type { CostDay } from './types';

/** From this share of the monthly budget on, the page warns. */
export const NEAR_BUDGET = 0.8;

export type BudgetLevel = 'none' | 'ok' | 'near' | 'over';

export interface BudgetStatus {
  /** 'none': no budget set. 'over': Tailor CV and Apply are refused. */
  level: BudgetLevel;
  /** Spent share of the budget in whole percent, rounded down; 0 without a budget. */
  percent: number;
  /** What is left of the budget, never below 0; 0 without a budget. */
  leftUsd: number;
}

/** Where this month's spend stands against the budget (0 = no limit). */
export function budgetStatus(spentUsd: number, budgetUsd: number): BudgetStatus {
  if (budgetUsd <= 0) return { level: 'none', percent: 0, leftUsd: 0 };
  const share = spentUsd / budgetUsd;
  const level = share >= 1 ? 'over' : share >= NEAR_BUDGET ? 'near' : 'ok';
  // Rounded down, so that 99.6 % does not read "100 %" while sessions still start.
  return { level, percent: Math.floor(share * 100), leftUsd: Math.max(0, budgetUsd - spentUsd) };
}

export const dayTotal = (day: CostDay) => day.login_usd + day.console_usd;

export interface AxisScale {
  /** Top of the axis: the first tick at or above the highest value. */
  max: number;
  /** From 0 to `max` in equal, round steps. */
  ticks: number[];
  step: number;
}

const ROUND_STEPS = [1, 2, 2.5, 5, 10];
/** Cuts the noise of binary fractions: 3 * 0.1 is 0.30000000000000004. */
const tidy = (value: number) => Number(value.toFixed(6));

/** A value axis from 0 with round steps, about `intervals` of them, that fits `peak`. */
export function axisScale(peak: number, intervals = 4): AxisScale {
  if (!(peak > 0)) return { max: 1, ticks: [0, 1], step: 1 };
  const rough = peak / intervals;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = tidy(
    power * (ROUND_STEPS.find((factor) => factor * power >= rough * (1 - 1e-9)) ?? 10),
  );
  const count = Math.ceil(tidy(peak / step));
  const ticks = Array.from({ length: count + 1 }, (_, index) => tidy(index * step));
  return { max: tidy(count * step), ticks, step };
}

/** A tick label with as many decimals as the step needs: $5, $2.50, $0.005. */
export function formatAxisUsd(value: number, step: number): string {
  const needed = [0, 1, 2, 3, 4].find((digits) => Number.isInteger(tidy(step * 10 ** digits)));
  // Money has no single decimal: $2.5 is written $2.50.
  const digits = needed === 1 ? 2 : (needed ?? 4);
  return `$${value.toFixed(digits)}`;
}

/**
 * Which days get a label under the chart: about `wanted` of them, evenly
 * spaced, counted back from the last day so that today always has one.
 */
export function labelledDays(count: number, wanted = 7): boolean[] {
  const every = Math.max(1, Math.ceil(count / wanted));
  return Array.from({ length: count }, (_, index) => (count - 1 - index) % every === 0);
}
