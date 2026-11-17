/**
 * Indian financial year (April–March) periods, bucketed by IST calendar date.
 *
 * Dates in this app are stored as the chosen day at 00:00 UTC (a few rows carry a real time),
 * so a date belongs to the IST day it falls on: UTC + 5:30. FY 2025-26 therefore covers the
 * instants [2025-03-31T18:30Z, 2026-03-31T18:30Z). A fiscal year is identified by its start
 * year (2025 = FY 2025-26). Ranges are half-open: { start, endExclusive }.
 *
 * Pure: every function that depends on "today" takes `asOf` (default `new Date()`).
 */

export const IST_OFFSET_MS = 330 * 60 * 1000;

export type FiscalPeriodKey = 'FY' | 'H1' | 'H2' | 'Q1' | 'Q2' | 'Q3' | 'Q4';
export const FISCAL_PERIOD_KEYS: readonly FiscalPeriodKey[] = ['FY', 'H1', 'H2', 'Q1', 'Q2', 'Q3', 'Q4'];

/** complete: ended on or before asOf; running: contains asOf; not-started: begins after asOf. */
export type FiscalPeriodStatus = 'complete' | 'running' | 'not-started';

export interface FiscalRange {
  start: Date;
  endExclusive: Date;
}

export interface MonthBucket extends FiscalRange {
  /** IST calendar month, e.g. `2025-04`. */
  key: string;
  /** e.g. `Apr 2025`. */
  label: string;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Months from April at which each period starts, and its length in months. */
const PERIOD_MONTHS: Readonly<Record<FiscalPeriodKey, { from: number; length: number }>> = {
  FY: { from: 0, length: 12 },
  H1: { from: 0, length: 6 },
  H2: { from: 6, length: 6 },
  Q1: { from: 0, length: 3 },
  Q2: { from: 3, length: 3 },
  Q3: { from: 6, length: 3 },
  Q4: { from: 9, length: 3 },
};

/** The instant IST midnight of (year, monthIndex 0–11, day) begins; month/day overflow rolls over. */
function istMidnight(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day) - IST_OFFSET_MS);
}

/** IST calendar date of an instant (month 1–12). */
export function istDateParts(date: Date | string): { year: number; month: number; day: number } {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** The instant the IST day containing `date` begins. */
export function istDayStart(date: Date | string): Date {
  const { year, month, day } = istDateParts(date);
  return istMidnight(year, month - 1, day);
}

/** The instant the IST day after `date` begins: the "to date" cutoff (rows at or after it are ignored). */
export function istNextDayStart(date: Date | string): Date {
  const { year, month, day } = istDateParts(date);
  return istMidnight(year, month - 1, day + 1);
}

/** IST calendar date as `YYYY-MM-DD`. */
export function istDayKey(date: Date | string): string {
  const { year, month, day } = istDateParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Start year of the fiscal year the IST date falls in (April onwards belongs to that year). */
export function fiscalYearOf(date: Date | string): number {
  const { year, month } = istDateParts(date);
  return month >= 4 ? year : year - 1;
}

export function fiscalPeriodRange(fy: number, period: FiscalPeriodKey): FiscalRange {
  const { from, length } = PERIOD_MONTHS[period];
  // April is month index 3; Date.UTC rolls months past December into the next year.
  return { start: istMidnight(fy, 3 + from, 1), endExclusive: istMidnight(fy, 3 + from + length, 1) };
}

/** The IST calendar months a range touches, each clipped to the range. Empty for an empty range. */
export function monthBuckets(range: FiscalRange): MonthBucket[] {
  const buckets: MonthBucket[] = [];
  const end = range.endExclusive.getTime();
  if (range.start.getTime() >= end) return buckets;
  const first = istDateParts(range.start);
  for (let index = first.month - 1; ; index++) {
    const monthStart = istMidnight(first.year, index, 1);
    if (monthStart.getTime() >= end) break;
    const next = istMidnight(first.year, index + 1, 1);
    const { year, month } = istDateParts(monthStart);
    buckets.push({
      key: `${year}-${String(month).padStart(2, '0')}`,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      start: monthStart < range.start ? range.start : monthStart,
      endExclusive: next.getTime() > end ? range.endExclusive : next,
    });
  }
  return buckets;
}

/** Fiscal years from the one containing `earliest` to the one containing `asOf`, ascending. */
export function listFiscalYears(earliest: Date | string | null | undefined, asOf: Date = new Date()): number[] {
  const last = fiscalYearOf(asOf);
  const parsed = earliest == null ? NaN : new Date(earliest).getTime();
  const first = Number.isNaN(parsed) ? last : Math.min(fiscalYearOf(new Date(parsed)), last);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

const twoDigits = (year: number) => String(year % 100).padStart(2, '0');

/** `FY 2025-26`. */
export function fiscalYearLabel(fy: number): string {
  return `FY ${fy}-${twoDigits(fy + 1)}`;
}

/**
 * The year the return is filed under: `AY 2025-26` for FY 2024-25, and from FY 2026-27 (the
 * Income-tax Act, 2025 takes effect on 1 April 2026) `Tax Year 2026-27`, which equals the FY.
 */
export function filingYearLabel(fy: number): string {
  return fy >= 2026 ? `Tax Year ${fy}-${twoDigits(fy + 1)}` : `AY ${fy + 1}-${twoDigits(fy + 2)}`;
}

/** `FY 2025-26`, `H1 (Apr–Sep 2025)`, `H2 (Oct 2025–Mar 2026)`, `Q4 (Jan–Mar 2026)`. */
export function fiscalPeriodLabel(fy: number, period: FiscalPeriodKey): string {
  if (period === 'FY') return fiscalYearLabel(fy);
  const { start, endExclusive } = fiscalPeriodRange(fy, period);
  const first = istDateParts(start);
  const last = istDateParts(new Date(endExclusive.getTime() - 1));
  const from = MONTH_NAMES[first.month - 1];
  const to = MONTH_NAMES[last.month - 1];
  const span = first.year === last.year ? `${from}–${to} ${last.year}` : `${from} ${first.year}–${to} ${last.year}`;
  return `${period} (${span})`;
}

export function fiscalPeriodStatus(range: FiscalRange, asOf: Date = new Date()): FiscalPeriodStatus {
  if (asOf.getTime() < range.start.getTime()) return 'not-started';
  return asOf.getTime() < range.endExclusive.getTime() ? 'running' : 'complete';
}

/** The range cut at the start of the IST day after `asOf` (empty when the period has not started). */
export function clampRangeToAsOf(range: FiscalRange, asOf: Date = new Date()): FiscalRange {
  const cutoff = Math.max(range.start.getTime(), Math.min(range.endExclusive.getTime(), istNextDayStart(asOf).getTime()));
  return { start: range.start, endExclusive: new Date(cutoff) };
}

/** `fy` query value: a four-digit start year (e.g. `2025`), or null. */
export function parseFiscalYear(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}$/.test(text)) return null;
  const fy = Number(text);
  return fy >= 2000 && fy <= 2099 ? fy : null;
}

/** `period` query value (case-insensitive), or null. */
export function parseFiscalPeriod(value: unknown): FiscalPeriodKey | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase();
  return (FISCAL_PERIOD_KEYS as readonly string[]).includes(key) ? (key as FiscalPeriodKey) : null;
}
