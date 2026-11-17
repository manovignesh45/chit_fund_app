/**
 * Reports data family (the tax report): keys, endpoint and reads.
 *
 *   const report = useItrReport({ fy: '2025', period: 'FY', scope: 'all' });
 *   const line = useItrLineRecords(params, { section: 'cash', line: 'loanRepayments' });
 *
 * Keys: ['reports', 'itr', null, params] → `/reports/itr?…`. Money writes invalidate the whole
 * resource (REPORTS is in MONEY_TAGS), and so does a category change
 * (invalidateTransactionCategories).
 */
import useSWR from 'swr';
import { queryKeys, registerEndpoint, type QueryKey } from './keys';
import type { ItrLineResponse, ItrLineSection, ItrReportResponse } from '../itrReportView';

export const REPORTS = 'reports';

registerEndpoint(REPORTS, (action, _id, params) => {
  const query = new URLSearchParams(params).toString();
  return `/reports/${action}${query ? `?${query}` : ''}`;
});

/** Empty values are left out (the API applies its defaults: current year, FY, all). */
export interface ItrReportParams {
  fy?: string;
  period?: string;
  scope?: string;
}

export interface ItrLineParams {
  section: ItrLineSection;
  line: string;
}

export const reportKeys = {
  itr: (params: ItrReportParams): QueryKey => queryKeys.action(REPORTS, 'itr', null, { ...params }),
  itrLine: (params: ItrReportParams, line: ItrLineParams): QueryKey =>
    queryKeys.action(REPORTS, 'itr', null, { ...params, section: line.section, line: line.line }),
};

/** The report for a period (records left out; each line has `recordCount`). Pass null to wait. */
export function useItrReport(params: ItrReportParams | null) {
  return useSWR<ItrReportResponse>(params ? reportKeys.itr(params) : null);
}

/** The records behind one line, read when the line is opened. Pass null for no line. */
export function useItrLineRecords(params: ItrReportParams | null, line: ItrLineParams | null) {
  return useSWR<ItrLineResponse>(params && line ? reportKeys.itrLine(params, line) : null);
}
