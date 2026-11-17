/**
 * Reports data family (the tax report): keys, endpoint and reads.
 *
 *   const report = useItrReport({ fy: '2025', period: 'FY', scope: 'all' });
 *   const line = useItrLineRecords(params, { section: 'cash', line: 'loanRepayments' });
 *
 * Keys: ['reports', 'itr', null, params] → `/reports/itr?…`. Money writes invalidate the whole
 * resource (REPORTS is in MONEY_TAGS), and so does a category change
 * (invalidateTransactionCategories).
 *
 *   const filename = await downloadItrReport(params);   // the Excel export, saved as a download
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

/**
 * Download the tax report as Excel (GET /api/reports/itr/export, same params) under the server's
 * file name, which it returns. Throws with the server's message when the export fails.
 */
export async function downloadItrReport(params: ItrReportParams): Promise<string> {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  const response = await fetch(`/api/reports/itr/export${query ? `?${query}` : ''}`);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to export the tax report');
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'tax-report.xlsx';
  const url = window.URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoked after the click has been handled, so the browser has started the download.
  setTimeout(() => window.URL.revokeObjectURL(url), 0);
  return filename;
}
