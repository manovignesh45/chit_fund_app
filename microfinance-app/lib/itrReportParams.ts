/**
 * Query parameters of the tax report routes (GET /api/reports/itr and /api/reports/itr/export):
 * `fy` (start year, default the current fiscal year), `period` (FY|H1|H2|Q1–Q4, default FY,
 * any case) and `scope` (all|chits|loans, default all, any case). Pure, shared by both routes so
 * they accept and reject exactly the same values.
 */
import { ITR_SCOPES, type ItrScope } from './itrReport';
import { fiscalYearOf, parseFiscalPeriod, parseFiscalYear, type FiscalPeriodKey } from './fiscalPeriods';

export interface ItrReportQuery {
  fy: number;
  period: FiscalPeriodKey;
  scope: ItrScope;
}

/** Exactly one of `query` and `error` is set. */
export type ItrReportQueryResult = { query: ItrReportQuery; error: null } | { query: null; error: string };

export function parseItrReportQuery(params: URLSearchParams, asOf: Date = new Date()): ItrReportQueryResult {
  const fyParam = params.get('fy');
  const fy = fyParam === null || fyParam === '' ? fiscalYearOf(asOf) : parseFiscalYear(fyParam);
  if (fy === null) return { query: null, error: 'fy must be the start year of a fiscal year, e.g. 2025 for FY 2025-26.' };

  const periodParam = params.get('period');
  const period: FiscalPeriodKey | null = periodParam === null || periodParam === '' ? 'FY' : parseFiscalPeriod(periodParam);
  if (period === null) return { query: null, error: 'period must be one of FY, H1, H2, Q1, Q2, Q3, Q4.' };

  const scopeParam = (params.get('scope') ?? '').trim().toLowerCase();
  const scope: ItrScope | null = scopeParam === '' ? 'all' : (ITR_SCOPES as readonly string[]).includes(scopeParam) ? (scopeParam as ItrScope) : null;
  if (scope === null) return { query: null, error: 'scope must be one of all, chits, loans.' };

  return { query: { fy, period, scope }, error: null };
}
