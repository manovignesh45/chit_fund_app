/**
 * The tax report as GET /api/reports/itr sends it. Pure, no React or Prisma: shared by the route
 * and the page (types only on the client).
 *
 * The full ItrReport carries every record behind every line: about 1.2 MB of JSON for a full year
 * of the seeded data (5,520 ledger rows), against about 7 KB without them. So the first response
 * carries each line's figures and record count only, and the page reads one line's records when
 * the user opens it (`&section=…&line=…`).
 */
import type { ItrLine, ItrRecord, ItrReport, ItrWarning } from './itrReport';

export type ItrLineSection = 'pl' | 'cash' | 'warning';
export const ITR_LINE_SECTIONS: readonly ItrLineSection[] = ['pl', 'cash', 'warning'];

export interface ItrLineSummary extends Omit<ItrLine, 'records'> {
  recordCount: number;
}

export interface ItrWarningSummary extends Omit<ItrWarning, 'records'> {
  recordCount: number;
}

export interface ItrReportView extends Omit<ItrReport, 'profitAndLoss' | 'cashFlow' | 'warnings'> {
  profitAndLoss: Omit<ItrReport['profitAndLoss'], 'income' | 'expenses'> & { income: ItrLineSummary[]; expenses: ItrLineSummary[] };
  cashFlow: Omit<ItrReport['cashFlow'], 'receipts' | 'payments' | 'transfers'> & {
    receipts: ItrLineSummary[];
    payments: ItrLineSummary[];
    transfers: ItrLineSummary | null;
  };
  warnings: ItrWarningSummary[];
}

export interface ItrFiscalYearOption {
  fy: number;
  /** `FY 2025-26`. */
  label: string;
  /** `AY 2026-27` / `Tax Year 2026-27`. */
  filingYearLabel: string;
  running: boolean;
}

export interface ItrReportResponse {
  report: ItrReportView;
  /** Newest first. */
  fiscalYears: ItrFiscalYearOption[];
  /** Record Amount entries of any date that still need a category. */
  unclassifiedCount: number;
}

/** The records behind one line (`&section=…&line=…`). */
export interface ItrLineRecords {
  section: ItrLineSection;
  key: string;
  label: string;
  total: number | null;
  records: ItrRecord[];
}

export interface ItrLineResponse {
  line: ItrLineRecords;
}

const summariseLine = ({ records, ...line }: ItrLine): ItrLineSummary => ({ ...line, recordCount: records.length });

/** The report without its records (each line keeps its record count). */
export function toItrReportView(report: ItrReport): ItrReportView {
  const { income, expenses, ...pl } = report.profitAndLoss;
  const { receipts, payments, transfers, ...cash } = report.cashFlow;
  return {
    ...report,
    profitAndLoss: { ...pl, income: income.map(summariseLine), expenses: expenses.map(summariseLine) },
    cashFlow: { ...cash, receipts: receipts.map(summariseLine), payments: payments.map(summariseLine), transfers: transfers ? summariseLine(transfers) : null },
    warnings: report.warnings.map(({ records, ...warning }) => ({ ...warning, recordCount: records?.length ?? 0 })),
  };
}

/**
 * One line's records: `pl` (income and expense lines), `cash` (receipts, payments and the
 * partner-transfers memo line, key `partnerTransfers`) or `warning` (key = warning code).
 * Null when the report has no such line. P&L and cash lines may share a key
 * (`documentCharges`), hence the section.
 */
export function findItrLine(report: ItrReport, section: ItrLineSection, key: string): ItrLineRecords | null {
  if (section === 'warning') {
    const warning = report.warnings.find((w) => w.code === key);
    return warning ? { section, key, label: warning.message, total: warning.amount ?? null, records: warning.records ?? [] } : null;
  }
  const lines: ItrLine[] = section === 'pl'
    ? [...report.profitAndLoss.income, ...report.profitAndLoss.expenses]
    : [...report.cashFlow.receipts, ...report.cashFlow.payments, ...(report.cashFlow.transfers ? [report.cashFlow.transfers] : [])];
  const line = lines.find((l) => l.key === key);
  return line ? { section, key, label: line.label, total: line.total, records: line.records } : null;
}

export function parseItrLineSection(value: unknown): ItrLineSection | null {
  return typeof value === 'string' && (ITR_LINE_SECTIONS as readonly string[]).includes(value) ? (value as ItrLineSection) : null;
}
