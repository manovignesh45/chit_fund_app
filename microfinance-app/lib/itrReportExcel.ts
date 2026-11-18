/**
 * Excel workbook of the tax report (GET /api/reports/itr/export), for the partners' accountant.
 * Pure: it writes what buildItrReport (lib/itrReport.ts) returns and reads nothing else, so the
 * file and the screen cannot disagree. Every figure the page shows (line amounts, month columns,
 * totals, net profit, partner shares, opening and closing cash) is written as the report's own
 * value, never as a spreadsheet formula. The only sums made here are columns the page does not
 * show (a chit payout's term contribution and payout, manual credits and debits, partner cash
 * columns, total loan interest across loan types), added in whole paise.
 *
 * Library: exceljs (as the loans export), because it writes the styling the accountant needs
 * (bold headers, frozen rows, number formats, print setup); the community xlsx build drops cell
 * styles on write.
 */
import * as ExcelJS from 'exceljs';
import type { ItrLine, ItrRecord, ItrReport, ItrScope, ItrSeries, ItrWarning } from './itrReport';
import { RECORD_AMOUNT_CATEGORIES } from './recordAmountCategories';
import { IST_OFFSET_MS, istDayKey } from './fiscalPeriods';
import { ITR_LEDGER_TYPE_LABELS, ITR_LOAN_TYPE_LABELS } from './itrReportView';

export const ITR_EXPORT_BUSINESS_NAME = 'AM Fincorp';
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ItrExcelOptions {
  /** When the file was made (shown in IST). */
  generatedAt: Date;
  /** Record Amount entries of any date that still need a category (GET /api/reports/itr's `unclassifiedCount`). */
  unclassifiedCount: number;
  /** Partner names by id. The report names partners only for All; Chits / Loans need these for the ledger. */
  partners?: { id: number; name: string }[];
}

export const ITR_SHEETS = {
  summary: 'Summary',
  profitAndLoss: 'Profit & loss',
  cashFlow: 'Cash flow',
  chitPayouts: 'Chit payouts',
  loanIncome: 'Loan income',
  manualEntries: 'Manual entries',
  badDebts: 'Bad debts',
  ledger: 'Ledger',
  notes: 'Notes',
} as const;

/** The sheets of an export, in order, for a scope. */
export function itrExportSheetNames(scope: ItrScope): string[] {
  const s = ITR_SHEETS;
  if (scope === 'chits') return [s.summary, s.profitAndLoss, s.cashFlow, s.chitPayouts, s.ledger, s.notes];
  if (scope === 'loans') return [s.summary, s.profitAndLoss, s.cashFlow, s.loanIncome, s.badDebts, s.ledger, s.notes];
  return [s.summary, s.profitAndLoss, s.cashFlow, s.chitPayouts, s.loanIncome, s.manualEntries, s.badDebts, s.ledger, s.notes];
}

/**
 * `tax-report-FY2025-26-Q1-all.xlsx`; a full year has no period part (`tax-report-FY2025-26-all.xlsx`)
 * and a running period ends with the as-of day (`…-all-to-2026-11-17.xlsx`). Lower-case words and
 * hyphens, as the transactions export names its files.
 */
export function itrExportFileName(report: ItrReport): string {
  const p = report.period;
  const parts = ['tax-report', p.fiscalYearLabel.replace(/\s+/g, ''), ...(p.period === 'FY' ? [] : [p.period]), p.scope];
  if (p.status === 'running' && p.asOf) parts.push('to', p.asOf);
  return `${parts.join('-')}.xlsx`;
}

// ---------------------------------------------------------------------------
// Formats and small helpers
// ---------------------------------------------------------------------------

/**
 * Indian grouping with two decimals (99,999.99 · 1,44,424.50 · 3,95,62,484.64), the sign always
 * shown. A number format cannot both group by lakh and crore and keep the minus sign (with
 * conditions, a section shows no sign of its own, in Excel and LibreOffice alike), so each cell
 * gets the plain `positive;negative` format for its own size. The cell value is exact; only its
 * display depends on the format.
 */
export const MONEY_FORMATS = {
  thousands: '#,##0.00;-#,##0.00',
  lakhs: '##\\,##\\,##0.00;-##\\,##\\,##0.00',
  crores: '##\\,##\\,##\\,##0.00;-##\\,##\\,##\\,##0.00',
} as const;

/** The money format for an amount: by lakh (1,00,000) and crore (1,00,00,000). */
export function moneyFormat(value: number): string {
  const size = Math.abs(value);
  return size >= 10000000 ? MONEY_FORMATS.crores : size >= 100000 ? MONEY_FORMATS.lakhs : MONEY_FORMATS.thousands;
}
export const DATE_FORMAT = 'dd mmm yyyy';
const DATETIME_FORMAT = 'dd mmm yyyy hh:mm "IST"';

const MONEY_WIDTH = 15;
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7ECF3' } };
const SECTION_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
const RESULT_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E0' } };
const THIN_TOP: Partial<ExcelJS.Borders> = { top: { style: 'thin' } };
const MUTED = { color: { argb: 'FF6B7280' } };
const A4 = 9 as ExcelJS.PaperSize;

/** Excel has no time zones: a calendar day is written as that day at 00:00 (UTC serial). */
function excelDay(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
/** The IST calendar day of an instant, as an Excel date. */
const istDay = (value: string | Date) => excelDay(istDayKey(value));
/** The last IST day before an exclusive end. */
const lastDayBefore = (endExclusive: string) => istDay(new Date(new Date(endExclusive).getTime() - 1));

const paise = (rupees: number) => Math.round(rupees * 100);
const sumRupees = (values: number[]) => values.reduce((sum, v) => sum + paise(v), 0) / 100;
/** No "-0.00" cells. */
const money = (value: number) => (value === 0 ? 0 : value);

const allZero = (s: ItrSeries) => s.total === 0 && s.months.every((m) => m === 0);
/** The page leaves out lines that are zero in every month; so does the file. */
const shownLines = (lines: ItrLine[]) => lines.filter((l) => !allZero(l));

const CATEGORY_LABEL = new Map<string, string>(RECORD_AMOUNT_CATEGORIES.map((c) => [c.value, c.label]));
const CATEGORY_PL = new Map<string, string>(RECORD_AMOUNT_CATEGORIES.map((c) => [c.value, c.profitAndLoss]));
const categoryLabel = (category: string | null | undefined) => (category ? CATEGORY_LABEL.get(category) ?? 'Unclassified' : 'Unclassified');

const SCOPE_TEXT: Record<ItrScope, string> = {
  all: 'All (chits, loans and shared items)',
  chits: 'Chits only',
  loans: 'Loans only',
};

type ColumnKind = 'text' | 'money' | 'date' | 'int';
const ALIGN: Partial<Record<ColumnKind, 'right' | 'center'>> = { money: 'right', int: 'center' };
interface ColumnSpec {
  header: string;
  width: number;
  kind: ColumnKind;
}

interface SheetSetup {
  title: string;
  landscape?: boolean;
  /** Frozen leading columns (statement sheets keep the line names in view). */
  freezeColumns?: number;
}

/** Printed footer: business and sheet name on the left, page number on the right (`&&` is a literal &). */
const footer = (sheetName: string) => `&L${ITR_EXPORT_BUSINESS_NAME} · ${sheetName.replace(/&/g, '&&')}&RPage &P of &N`;

const SHEET_TITLE_ROW = 1;
const SHEET_SUBTITLE_ROW = 2;
const HEADER_ROW = 3;

class SheetWriter {
  readonly ws: ExcelJS.Worksheet;
  private columns: ColumnSpec[] = [];

  constructor(wb: ExcelJS.Workbook, name: string, private readonly report: ItrReport, setup: SheetSetup) {
    this.ws = wb.addWorksheet(name, {
      views: [{ state: 'frozen', xSplit: setup.freezeColumns ?? 0, ySplit: HEADER_ROW, showGridLines: true }],
      pageSetup: {
        paperSize: A4,
        orientation: setup.landscape ? 'landscape' : 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
      },
      headerFooter: { oddFooter: footer(name) },
    });
    const title = this.ws.getCell(SHEET_TITLE_ROW, 1);
    title.value = `${setup.title}: ${periodHeadline(report)}`;
    title.font = { bold: true, size: 13 };
    const subtitle = this.ws.getCell(SHEET_SUBTITLE_ROW, 1);
    subtitle.value = `${ITR_EXPORT_BUSINESS_NAME} · ${SCOPE_TEXT[report.period.scope]} · ${dateSpanText(report)} · amounts in ₹`;
    subtitle.font = { italic: true, ...MUTED };
  }

  /** The column header row (row 3, frozen and repeated on every printed page). */
  header(columns: ColumnSpec[]): void {
    this.columns = columns;
    columns.forEach((c, i) => {
      this.ws.getColumn(i + 1).width = c.width;
    });
    this.headingRow(HEADER_ROW, columns.map((c) => c.header));
  }

  /** A bold, shaded row of column names at `rowNumber` (a second table further down uses it too). */
  headingRow(rowNumber: number, labels: string[], kinds: ColumnKind[] = this.columns.map((c) => c.kind)): void {
    const row = this.ws.getRow(rowNumber);
    let lines = 1;
    labels.forEach((label, i) => {
      const cell = row.getCell(i + 1);
      cell.value = label;
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.border = { bottom: { style: 'thin' } };
      cell.alignment = { vertical: 'middle', wrapText: true, horizontal: ALIGN[kinds[i]] ?? 'left' };
      const width = this.ws.getColumn(i + 1).width ?? 10;
      lines = Math.max(lines, Math.ceil((label.length * 1.15) / Math.max(4, width - 1)));
    });
    // Wrapped column names need the room: not every spreadsheet grows the row on open.
    if (lines > 1) row.height = lines * 15 + 2;
  }

  /** Appends a row; each value is formatted by its column's kind (or `kinds`, for a second table). */
  row(values: (string | number | Date | null | undefined)[], style: { bold?: boolean; italic?: boolean; fill?: ExcelJS.Fill; topBorder?: boolean } = {}, kinds?: ColumnKind[]): ExcelJS.Row {
    const row = this.ws.addRow([]);
    values.forEach((value, i) => {
      const kind = kinds?.[i] ?? this.columns[i]?.kind ?? 'text';
      const cell = row.getCell(i + 1);
      if (value === null || value === undefined || value === '') {
        cell.value = null;
      } else if (kind === 'money' && typeof value === 'number') {
        cell.value = money(value);
        cell.numFmt = moneyFormat(value);
      } else if (kind === 'date' && value instanceof Date) {
        cell.value = value;
        cell.numFmt = DATE_FORMAT;
        cell.alignment = { horizontal: 'left' };
      } else if (kind === 'int' && typeof value === 'number') {
        cell.value = value;
        cell.numFmt = '0';
        cell.alignment = { horizontal: 'center' };
      } else {
        cell.value = value as string | number;
      }
    });
    const width = Math.max(values.length, this.columns.length);
    for (let i = 1; i <= width; i++) {
      const cell = row.getCell(i);
      if (style.bold || style.italic) cell.font = { bold: style.bold, italic: style.italic, ...(style.italic ? MUTED : {}) };
      if (style.fill) cell.fill = style.fill;
      if (style.topBorder) cell.border = THIN_TOP;
    }
    return row;
  }

  blank(): void {
    this.ws.addRow([]);
  }

  /** A one-cell message row (e.g. "None in this period"). */
  note(text: string, italic = true): void {
    const row = this.ws.addRow([text]);
    row.getCell(1).font = italic ? { italic: true, ...MUTED } : {};
  }

  /** A bold section title row, shaded across the table's width. */
  section(text: string, width = this.columns.length): void {
    const row = this.ws.addRow([text]);
    for (let i = 1; i <= Math.max(width, 1); i++) {
      row.getCell(i).fill = SECTION_FILL;
      row.getCell(i).font = { bold: true };
    }
  }
}

function periodHeadline(report: ItrReport): string {
  const p = report.period;
  const label = p.period === 'FY' ? p.label : `${p.label}, ${p.fiscalYearLabel}`;
  return `${label} (${p.filingYearLabel})${p.status === 'running' && p.asOf ? `, to date as of ${formatDayKey(p.asOf)}` : ''}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

function dateSpanText(report: ItrReport): string {
  const p = report.period;
  const from = istDayKey(p.start);
  if (p.status === 'not-started') return `${formatDayKey(from)} to ${formatDayKey(istDayKey(new Date(new Date(p.fullEndExclusive).getTime() - 1)))} (not started)`;
  return `${formatDayKey(from)} to ${formatDayKey(istDayKey(new Date(new Date(p.endExclusive).getTime() - 1)))}`;
}

/** Partner name lookup: the report's partner rows first, then the names passed in. */
function partnerNamer(report: ItrReport, options: ItrExcelOptions) {
  const names = new Map<number, string>();
  for (const p of options.partners ?? []) names.set(p.id, p.name);
  for (const p of report.cashFlow.partners) if (p.partnerId !== null) names.set(p.partnerId, p.name);
  for (const p of report.partnerShare?.partners ?? []) names.set(p.partnerId, p.name);
  return (id: number | null | undefined) => (id == null ? 'Unassigned' : names.get(id) ?? `Partner #${id}`);
}

const findLine = (lines: ItrLine[], key: string) => lines.find((l) => l.key === key) ?? null;

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** Plain-words text for a warning (the page's wording, without links). */
function warningText(w: ItrWarning): { title: string; text: string } {
  const n = w.count ?? 0;
  switch (w.code) {
    case 'UNCLASSIFIED_ENTRIES':
      return {
        title: 'Unclassified manual entries',
        text: `${n} manual ${n === 1 ? 'entry' : 'entries'} in this period ${n === 1 ? 'has' : 'have'} no category, so ${n === 1 ? 'it is' : 'they are'} left out of the profit & loss. They still count in the cash flow. See the Manual entries sheet.`,
      };
    case 'NEGATIVE_OPENING_CASH':
      return { title: 'Negative opening cash', text: 'Cash at the start of this period is negative: more was paid out than was recorded coming in before it. The difference was funded outside the ledger.' };
    case 'NEGATIVE_CLOSING_CASH':
      return { title: 'Negative closing cash', text: 'Cash at the end of this period is negative: more was paid out than was recorded coming in. The difference was funded outside the ledger.' };
    case 'PERIOD_RUNNING':
      return { title: 'Period still running', text: 'This period is still running. The figures are to date and will change as entries are added.' };
    default:
      return { title: 'Note', text: w.message };
  }
}

function addSummary(wb: ExcelJS.Workbook, report: ItrReport, options: ItrExcelOptions, sheets: string[]): void {
  const p = report.period;
  const ws = wb.addWorksheet(ITR_SHEETS.summary, {
    pageSetup: { paperSize: A4, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
    headerFooter: { oddFooter: footer(ITR_SHEETS.summary) },
  });
  ws.getColumn(1).width = 36;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 80;

  const put = (label: string, value: string | number | Date | null, kind: ColumnKind | 'datetime' = 'text', extra?: string, bold = false) => {
    const row = ws.addRow([label]);
    const cell = row.getCell(2);
    if (value !== null) {
      cell.value = kind === 'money' && typeof value === 'number' ? money(value) : value;
      if (kind === 'money' && typeof value === 'number') cell.numFmt = moneyFormat(value);
      if (kind === 'date') { cell.numFmt = DATE_FORMAT; cell.alignment = { horizontal: 'left' }; }
      if (kind === 'datetime') { cell.numFmt = DATETIME_FORMAT; cell.alignment = { horizontal: 'left' }; }
      if (kind === 'int') cell.alignment = { horizontal: 'left' };
    }
    if (extra) {
      row.getCell(3).value = extra;
      row.getCell(3).alignment = { wrapText: true, vertical: 'top', indent: 1 };
      // Not every spreadsheet grows a wrapped row on open: size it for about 90 characters a line.
      const lines = Math.ceil(extra.length / 90);
      if (lines > 1) row.height = lines * 15;
    }
    if (bold) row.eachCell({ includeEmpty: true }, (c) => { c.font = { bold: true }; });
    row.getCell(1).alignment = { vertical: 'top' };
    cell.alignment = { ...cell.alignment, vertical: 'top' };
    return row;
  };
  const heading = (text: string) => {
    ws.addRow([]);
    const row = ws.addRow([text]);
    for (let i = 1; i <= 3; i++) {
      row.getCell(i).fill = SECTION_FILL;
      row.getCell(i).font = { bold: true };
      row.getCell(i).border = { bottom: { style: 'thin' } };
    }
  };

  const title = ws.addRow([ITR_EXPORT_BUSINESS_NAME]);
  title.getCell(1).font = { bold: true, size: 15 };
  const subtitle = ws.addRow([`Tax report: profit & loss, cash flow and partner share, ${periodHeadline(report)}`]);
  subtitle.getCell(1).font = { bold: true, size: 12 };
  const tag = ws.addRow(['A supporting statement prepared from the business records in the app. It is not a tax computation.']);
  tag.getCell(1).font = { italic: true, ...MUTED };

  heading('Reporting period');
  put('Period', p.label);
  put('Financial year', p.fiscalYearLabel, 'text', 'Indian financial year, 1 April to 31 March; entries are dated by their Indian (IST) calendar date.');
  put(p.filingYearLabel.startsWith('AY') ? 'Assessment year' : 'Tax year', p.filingYearLabel);
  put('Scope', SCOPE_TEXT[p.scope]);
  put('From', istDay(p.start), 'date');
  if (p.status === 'not-started') {
    put('To', lastDayBefore(p.fullEndExclusive), 'date', 'This period has not started yet: no figures.');
  } else {
    put('To', lastDayBefore(p.endExclusive), 'date', p.status === 'running' ? 'The period is still running; figures run to the date below.' : undefined);
  }
  if (p.status === 'running' && p.asOf) put('To date as of', excelDay(p.asOf), 'date', 'Figures will change as entries are added for the rest of the period.');
  put('Generated', new Date(options.generatedAt.getTime() + IST_OFFSET_MS), 'datetime');
  put('Amounts', 'Indian rupees (₹), to the paisa');

  heading('Profit & loss');
  const pl = report.profitAndLoss;
  ws.addRow(['Income']).getCell(1).font = { bold: true };
  for (const l of shownLines(pl.income)) put(`   ${l.label}`, l.total, 'money');
  put('Total income', pl.totalIncome.total, 'money', undefined, true).eachCell({ includeEmpty: true }, (c) => { c.border = THIN_TOP; });
  if (pl.expenses.length) {
    ws.addRow(['Expenses']).getCell(1).font = { bold: true };
    for (const l of shownLines(pl.expenses)) put(`   ${l.label}`, l.total, 'money');
    put('Total expenses', pl.totalExpenses.total, 'money', undefined, true).eachCell({ includeEmpty: true }, (c) => { c.border = THIN_TOP; });
  }
  const net = put(report.sharedItemsAllocated ? 'Net profit' : `Net profit (${p.scope === 'chits' ? 'Chits' : 'Loans'}, before shared items)`, pl.netProfit.total, 'money', 'Total income − total expenses.', true);
  for (let i = 1; i <= 3; i++) net.getCell(i).fill = RESULT_FILL;

  if (report.partnerShare) {
    heading('Partner share');
    for (const s of report.partnerShare.partners) put(s.name, s.share, 'money', 'Equal share of the net profit.');
    put('Net profit shared', report.partnerShare.netProfit, 'money', undefined, true);
  } else {
    heading('Shared items');
    const row = ws.addRow([`Shared expenses and other income are not allocated to ${p.scope === 'chits' ? 'Chits' : 'Loans'}; they appear in the All report. Partner share is given in the All report only.`]);
    ws.mergeCells(row.number, 1, row.number, 3);
    row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    row.height = 32;
  }

  heading('Cash');
  const cf = report.cashFlow;
  if (!cf.pooled && cf.opening !== null && cf.closing !== null) {
    put('Opening cash', cf.opening, 'money', 'Cash held by the business at the start of the period (every earlier ledger entry).');
    put('Total receipts', cf.totalReceipts.total, 'money');
    put('Total payments', cf.totalPayments.total, 'money');
    put('Net cash movement', cf.netMovement.total, 'money', 'Receipts − payments.');
    const closing = put('Closing cash', cf.closing, 'money', 'Opening cash + net cash movement; equals the total balance held by the partners.', true);
    for (let i = 1; i <= 3; i++) closing.getCell(i).fill = RESULT_FILL;
  } else {
    put('Total receipts', cf.totalReceipts.total, 'money');
    put('Total payments', cf.totalPayments.total, 'money');
    put('Net cash movement', cf.netMovement.total, 'money', 'Receipts − payments. Cash is pooled across the business, so there is no opening or closing balance for one line of business.', true);
  }

  heading('Warnings');
  if (!report.warnings.length && options.unclassifiedCount === 0) {
    put('None', null);
  }
  for (const w of report.warnings) {
    const { title: t, text } = warningText(w);
    put(t, w.amount ?? null, 'money', text);
  }
  if (options.unclassifiedCount > 0) {
    put('Entries to classify (any date)', options.unclassifiedCount, 'int',
      `${options.unclassifiedCount} manual ${options.unclassifiedCount === 1 ? 'entry' : 'entries'} in the app (of any date) still ${options.unclassifiedCount === 1 ? 'needs' : 'need'} a category. Unclassified entries are kept out of the profit & loss.`);
  }

  heading('Sheets in this file');
  const about: Record<string, string> = {
    [ITR_SHEETS.summary]: 'This page.',
    [ITR_SHEETS.profitAndLoss]: 'Income and expenses, month by month.',
    [ITR_SHEETS.cashFlow]: 'Receipts and payments from the cash ledger, month by month, with the cash each partner holds.',
    [ITR_SHEETS.chitPayouts]: 'Each chit payout and the margin on it.',
    [ITR_SHEETS.loanIncome]: 'Interest received on each loan, and document charges.',
    [ITR_SHEETS.manualEntries]: 'Every manual (Record Amount) entry, with its category.',
    [ITR_SHEETS.badDebts]: 'Loans written off as non-recoverable, and amounts recovered on them.',
    [ITR_SHEETS.ledger]: 'Every ledger entry behind the cash flow.',
    [ITR_SHEETS.notes]: 'The rules used to prepare the figures.',
  };
  for (const name of sheets) put(name, null, 'text', about[name]);
}

/** Statement sheet rows: label, a value per month, total. */
interface StatementRow {
  label: string;
  months: (number | null)[];
  total: number | null;
  style?: 'heading' | 'total' | 'result' | 'balance' | 'memo';
}

function writeStatement(sheet: SheetWriter, report: ItrReport, rows: StatementRow[]): void {
  const months = report.months;
  sheet.header([
    { header: 'Line', width: 40, kind: 'text' },
    ...months.map((m) => ({ header: m.label, width: MONEY_WIDTH, kind: 'money' as const })),
    { header: 'Total', width: MONEY_WIDTH + 2, kind: 'money' },
  ]);
  const width = months.length + 2;
  for (const r of rows) {
    if (r.style === 'heading') {
      sheet.section(r.label, width);
      continue;
    }
    const values = [r.style ? r.label : `   ${r.label}`, ...r.months, r.total];
    const style = r.style === 'total' ? { bold: true, topBorder: true }
      : r.style === 'result' || r.style === 'balance' ? { bold: true, fill: RESULT_FILL, topBorder: r.style === 'result' }
        : r.style === 'memo' ? { italic: true } : {};
    sheet.row(values, style);
  }
}

const lineRow = (l: ItrLine): StatementRow => ({ label: l.label, months: l.months, total: l.total });
const seriesRow = (label: string, s: ItrSeries, style: StatementRow['style']): StatementRow => ({ label, months: s.months, total: s.total, style });
const headingRow = (label: string): StatementRow => ({ label, months: [], total: null, style: 'heading' });

function addProfitAndLoss(wb: ExcelJS.Workbook, report: ItrReport): void {
  const sheet = new SheetWriter(wb, ITR_SHEETS.profitAndLoss, report, { title: 'Profit & loss', landscape: true, freezeColumns: 1 });
  const pl = report.profitAndLoss;
  const rows: StatementRow[] = [headingRow('Income'), ...shownLines(pl.income).map(lineRow), seriesRow('Total income', pl.totalIncome, 'total')];
  if (pl.expenses.length) rows.push(headingRow('Expenses'), ...shownLines(pl.expenses).map(lineRow), seriesRow('Total expenses', pl.totalExpenses, 'total'));
  rows.push(seriesRow('Net profit', pl.netProfit, 'result'));
  writeStatement(sheet, report, rows);
  if (!report.sharedItemsAllocated) {
    sheet.blank();
    for (const note of report.notes) sheet.note(note);
  }
}

function addCashFlow(wb: ExcelJS.Workbook, report: ItrReport): void {
  const sheet = new SheetWriter(wb, ITR_SHEETS.cashFlow, report, { title: 'Cash flow', landscape: true, freezeColumns: 1 });
  const cf = report.cashFlow;
  const n = report.months.length;
  const rows: StatementRow[] = [];
  if (!cf.pooled && cf.opening !== null && cf.closingByMonth) {
    // Each month opens with the previous month's closing balance (as on the page).
    rows.push({ label: 'Opening balance', total: cf.opening, months: [cf.opening, ...cf.closingByMonth.slice(0, -1)].slice(0, n), style: 'balance' });
  }
  rows.push(headingRow('Receipts'), ...shownLines(cf.receipts).map(lineRow), seriesRow('Total receipts', cf.totalReceipts, 'total'));
  rows.push(headingRow('Payments'), ...shownLines(cf.payments).map(lineRow), seriesRow('Total payments', cf.totalPayments, 'total'));
  rows.push(seriesRow('Net cash movement', cf.netMovement, 'result'));
  if (!cf.pooled && cf.closing !== null && cf.closingByMonth) {
    rows.push({ label: 'Closing balance', total: cf.closing, months: cf.closingByMonth, style: 'balance' });
  }
  if (cf.transfers) rows.push({ label: cf.transfers.label, months: cf.transfers.months, total: cf.transfers.total, style: 'memo' });
  writeStatement(sheet, report, rows);

  sheet.blank();
  if (cf.pooled) {
    sheet.note('Cash is pooled across the business, so this view shows receipts, payments and net movement only (no opening or closing balance, no partner cash).');
    return;
  }
  sheet.note('Partner transfers move cash between partners and do not change the total.');
  sheet.blank();

  // Partner-wise cash (under the month columns; each column is labelled in its own heading row).
  const kinds: ColumnKind[] = ['text', 'money', 'money', 'money', 'money', 'money', 'money', 'money'];
  const shares = new Map((report.partnerShare?.partners ?? []).map((p) => [p.partnerId, p.share]));
  sheet.section('Cash held by each partner', Math.max(n + 2, kinds.length));
  const head = sheet.ws.addRow([]);
  sheet.headingRow(head.number, ['Partner', 'Opening cash', 'Received', 'Paid out', 'Transfers in', 'Transfers out', 'Cash held at the end', 'Profit share'], kinds);
  for (const p of cf.partners) {
    sheet.row([p.name, p.opening, p.in, p.out, p.transfersIn, p.transfersOut, p.closing, p.partnerId !== null ? shares.get(p.partnerId) ?? null : null], {}, kinds);
  }
  sheet.row([
    'Total', cf.opening, sumRupees(cf.partners.map((p) => p.in)), sumRupees(cf.partners.map((p) => p.out)),
    sumRupees(cf.partners.map((p) => p.transfersIn)), sumRupees(cf.partners.map((p) => p.transfersOut)), cf.closing, report.partnerShare?.netProfit ?? null,
  ], { bold: true, topBorder: true }, kinds);
  if (cf.partners.some((p) => p.partnerId === null)) sheet.note('Unassigned: entries that name no partner on that side.');
  // The partner table is wider than a one-month statement: keep its columns readable.
  for (let i = 2; i <= kinds.length; i++) {
    const col = sheet.ws.getColumn(i);
    col.width = Math.max(col.width ?? 0, MONEY_WIDTH);
  }
}

function addChitPayouts(wb: ExcelJS.Workbook, report: ItrReport): void {
  const sheet = new SheetWriter(wb, ITR_SHEETS.chitPayouts, report, { title: 'Chit payouts', landscape: true });
  sheet.header([
    { header: 'Payout date', width: 13, kind: 'date' },
    { header: 'Chit fund', width: 26, kind: 'text' },
    { header: 'Month no.', width: 10, kind: 'int' },
    { header: 'Member (winner)', width: 26, kind: 'text' },
    { header: 'Term contribution', width: MONEY_WIDTH + 2, kind: 'money' },
    { header: 'Payout', width: MONEY_WIDTH, kind: 'money' },
    { header: 'Margin', width: MONEY_WIDTH, kind: 'money' },
    { header: 'Auction no.', width: 11, kind: 'int' },
  ]);
  const line = findLine(report.profitAndLoss.income, 'chitMargin');
  const records = line?.records ?? [];
  if (!records.length) {
    sheet.note('None in this period.');
    return;
  }
  for (const r of records) {
    sheet.row([r.date ? istDay(r.date) : null, r.fundName ?? '', r.month ?? null, r.member ?? '', r.termContribution ?? null, r.payout ?? null, r.amount, r.id]);
  }
  sheet.row(['Total', null, null, `${records.length} ${records.length === 1 ? 'payout' : 'payouts'}`,
    sumRupees(records.map((r) => r.termContribution ?? 0)), sumRupees(records.map((r) => r.payout ?? 0)), line!.total, null], { bold: true, topBorder: true });
}

function addLoanIncome(wb: ExcelJS.Workbook, report: ItrReport): void {
  const sheet = new SheetWriter(wb, ITR_SHEETS.loanIncome, report, { title: 'Loan income', landscape: true });
  const interestKinds: ColumnKind[] = ['int', 'text', 'text', 'int', 'money'];
  sheet.header([
    { header: 'Loan no.', width: 10, kind: 'int' },
    { header: 'Borrower', width: 28, kind: 'text' },
    { header: 'Loan type', width: 24, kind: 'text' },
    { header: 'Repayments in the period', width: 16, kind: 'int' },
    { header: 'Interest', width: MONEY_WIDTH + 2, kind: 'money' },
  ]);
  const interestLines = report.profitAndLoss.income.filter((l) => l.key.startsWith('loanInterest:'));
  const interest = interestLines.flatMap((l) => l.records).sort((a, b) => (a.loanId ?? a.id) - (b.loanId ?? b.id));
  if (!interest.length) sheet.note('No loan interest in this period.');
  for (const r of interest) {
    sheet.row([r.loanId ?? r.id, r.borrower ?? '', r.loanType ? ITR_LOAN_TYPE_LABELS[r.loanType] ?? r.loanType : '', r.repaymentCount ?? 0, r.amount], {}, interestKinds);
  }
  for (const l of interestLines) sheet.row([null, l.label, null, null, l.total], { bold: true }, interestKinds);
  sheet.row([null, 'Total loan interest', null, null, sumRupees(interestLines.map((l) => l.total))], { bold: true, topBorder: true }, interestKinds);

  sheet.blank();
  const docKinds: ColumnKind[] = ['int', 'text', 'text', 'date', 'money'];
  sheet.section('Document charges (kept back from the loan, income on the disbursement date)', 5);
  sheet.headingRow(sheet.ws.addRow([]).number, ['Loan no.', 'Borrower', 'Loan type', 'Disbursement date', 'Document charge'], docKinds);
  const docs = findLine(report.profitAndLoss.income, 'documentCharges');
  if (!docs || !docs.records.length) {
    sheet.note('None in this period.');
    return;
  }
  for (const r of docs.records) {
    sheet.row([r.loanId ?? r.id, r.borrower ?? '', r.loanType ? ITR_LOAN_TYPE_LABELS[r.loanType] ?? r.loanType : '', r.date ? istDay(r.date) : null, r.amount], {}, docKinds);
  }
  sheet.row([null, 'Total document charges', null, null, docs.total], { bold: true, topBorder: true }, docKinds);
}

/** Manual (RECORD_AMOUNT) ledger records of the period, oldest first. */
export function itrManualEntries(report: ItrReport): { record: ItrRecord; direction: 'credit' | 'debit' }[] {
  const cf = report.cashFlow;
  const pick = (lines: ItrLine[], direction: 'credit' | 'debit') =>
    lines.flatMap((l) => l.records.filter((r) => r.kind === 'ledger' && r.type === 'RECORD_AMOUNT').map((record) => ({ record, direction })));
  return [...pick(cf.receipts, 'credit'), ...pick(cf.payments, 'debit')]
    .sort((a, b) => (a.record.date ?? '').localeCompare(b.record.date ?? '') || a.record.id - b.record.id);
}

function addManualEntries(wb: ExcelJS.Workbook, report: ItrReport, partnerName: (id: number | null | undefined) => string): void {
  const sheet = new SheetWriter(wb, ITR_SHEETS.manualEntries, report, { title: 'Manual entries', landscape: true });
  sheet.header([
    { header: 'Date', width: 13, kind: 'date' },
    { header: 'Entry no.', width: 10, kind: 'int' },
    { header: 'Partner', width: 18, kind: 'text' },
    { header: 'Credit / debit', width: 16, kind: 'text' },
    { header: 'Category', width: 22, kind: 'text' },
    { header: 'In the profit & loss as', width: 24, kind: 'text' },
    { header: 'Note', width: 40, kind: 'text' },
    { header: 'Amount', width: MONEY_WIDTH, kind: 'money' },
  ]);
  const entries = itrManualEntries(report);
  if (!entries.length) {
    sheet.note('None in this period.');
    return;
  }
  const plText = (category: string | null | undefined) => {
    const pl = category ? CATEGORY_PL.get(category) : undefined;
    if (!pl) return 'Left out (unclassified)';
    return pl === 'income' ? 'Other income' : pl === 'expense' ? 'Expense' : 'Not in profit & loss';
  };
  for (const { record: r, direction } of entries) {
    sheet.row([r.date ? istDay(r.date) : null, r.id, partnerName(r.partnerId), direction === 'credit' ? 'Credit (money in)' : 'Debit (money out)',
      categoryLabel(r.category), plText(r.category), r.note ?? '', r.amount]);
  }
  const credits = entries.filter((e) => e.direction === 'credit').map((e) => e.record.amount);
  const debits = entries.filter((e) => e.direction === 'debit').map((e) => e.record.amount);
  sheet.row(['Total credits', null, null, null, null, null, `${credits.length} ${credits.length === 1 ? 'entry' : 'entries'}`, sumRupees(credits)], { bold: true, topBorder: true });
  sheet.row(['Total debits', null, null, null, null, null, `${debits.length} ${debits.length === 1 ? 'entry' : 'entries'}`, sumRupees(debits)], { bold: true });
}

function addBadDebts(wb: ExcelJS.Workbook, report: ItrReport): void {
  const sheet = new SheetWriter(wb, ITR_SHEETS.badDebts, report, { title: 'Bad debts', landscape: true });
  sheet.header([
    { header: 'Date', width: 13, kind: 'date' },
    { header: 'Loan no.', width: 10, kind: 'int' },
    { header: 'Borrower', width: 28, kind: 'text' },
    { header: 'Loan type', width: 24, kind: 'text' },
    { header: 'Amount', width: MONEY_WIDTH + 2, kind: 'money' },
    { header: 'Principal still outstanding now', width: 20, kind: 'money' },
  ]);
  const writtenOff = findLine(report.profitAndLoss.expenses, 'badDebtWrittenOff');
  const recovered = findLine(report.profitAndLoss.income, 'badDebtRecovered');
  if (!writtenOff?.records.length && !recovered?.records.length) {
    sheet.note('None in this period.');
    return;
  }
  const loanType = (r: ItrRecord) => (r.loanType ? ITR_LOAN_TYPE_LABELS[r.loanType] ?? r.loanType : '');
  const block = (title: string, totalLabel: string, line: ItrLine | null, outstanding: boolean) => {
    sheet.section(title, 6);
    if (!line || !line.records.length) {
      sheet.note('None in this period.');
      return;
    }
    for (const r of line.records) sheet.row([r.date ? istDay(r.date) : null, r.loanId ?? null, r.borrower ?? '', loanType(r), r.amount, outstanding ? r.outstanding ?? null : null]);
    sheet.row([totalLabel, null, null, null, line.total, null], { bold: true, topBorder: true });
  };
  block('Written off (principal outstanding on the date the loan was marked non-recoverable)', 'Total written off', writtenOff, true);
  sheet.blank();
  block('Recovered (principal received later on a written-off loan)', 'Total recovered', recovered, false);
}

function addLedger(wb: ExcelJS.Workbook, report: ItrReport, partnerName: (id: number | null | undefined) => string): void {
  const sheet = new SheetWriter(wb, ITR_SHEETS.ledger, report, { title: 'Ledger', landscape: true });
  sheet.header([
    { header: 'Date', width: 13, kind: 'date' },
    { header: 'Entry no.', width: 10, kind: 'int' },
    { header: 'Type', width: 20, kind: 'text' },
    { header: 'Category', width: 20, kind: 'text' },
    { header: 'Partner(s)', width: 22, kind: 'text' },
    { header: 'Note', width: 36, kind: 'text' },
    { header: 'Cash-flow line', width: 30, kind: 'text' },
    { header: 'Amount in', width: MONEY_WIDTH, kind: 'money' },
    { header: 'Amount out', width: MONEY_WIDTH, kind: 'money' },
    { header: 'Partner transfer (memo)', width: MONEY_WIDTH + 2, kind: 'money' },
  ]);
  const cf = report.cashFlow;
  const rows = [
    ...cf.receipts.flatMap((l) => l.records.map((record) => ({ record, line: l, side: 'in' as const }))),
    ...cf.payments.flatMap((l) => l.records.map((record) => ({ record, line: l, side: 'out' as const }))),
    ...(cf.transfers ? cf.transfers.records.map((record) => ({ record, line: cf.transfers!, side: 'transfer' as const })) : []),
  ].sort((a, b) => (a.record.date ?? '').localeCompare(b.record.date ?? '') || a.record.id - b.record.id);
  if (!rows.length) {
    sheet.note('None in this period.');
    return;
  }
  for (const { record: r, line, side } of rows) {
    const partners = side === 'transfer' ? `${partnerName(r.partnerId)} → ${partnerName(r.toPartnerId)}` : partnerName(r.partnerId);
    sheet.row([
      r.date ? istDay(r.date) : null, r.id, ITR_LEDGER_TYPE_LABELS[r.type ?? ''] ?? r.type ?? '', r.type === 'RECORD_AMOUNT' ? categoryLabel(r.category) : '',
      partners, r.note ?? '', line.label,
      side === 'in' ? r.amount : null, side === 'out' ? r.amount : null, side === 'transfer' ? r.amount : null,
    ]);
  }
  sheet.row(['Total', null, `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`, null, null, null, null,
    cf.totalReceipts.total, cf.totalPayments.total, cf.transfers ? cf.transfers.total : null], { bold: true, topBorder: true });
}

/** The rules used, for the accountant (also the scope notes and the warning about classification). */
export function itrExportNotes(report: ItrReport): string[] {
  return [
    'Chit margin: for each chit payout, margin = the winner\'s full-term contribution (every instalment the fund\'s terms set for its whole duration) − the payout. The whole margin is recognised on the payout date, before the winner\'s remaining instalments are collected.',
    'Loan interest is recognised when it is received. Monthly loans: the fixed interest of each instalment received. Weekly loans: only after the principal is fully collected; everything received beyond the principal is interest. Reducing Balance loans: the interest portion of each payment (outstanding principal × the monthly rate). Interest received on a recovery receipt counts as loan interest.',
    'Document charge: kept back from the loan when it is paid out (the borrower receives the loan less the charge) and recognised as income on the disbursement date.',
    'Bad debt: the principal outstanding when a loan was marked non-recoverable is written off on that date. Principal recovered on that loan later is income ("Bad debt recovered") on the date received. A loan restored to active is not written off.',
    'Other income and expenses are the manual (Record Amount) entries in the categories Other income and Expense. The other categories (opening balance, capital introduced, partner drawings, advances given and returned, balance corrections) move cash only and are not in the profit & loss.',
    'Unclassified manual entries are excluded from profit until a category is chosen in the app; they still count in the cash flow.',
    'Profit is shared equally between the partners (any odd paisa goes to the first partner). Cash held by each partner is a separate figure from the ledger.',
    'Cash flow comes from the app\'s ledger. The opening balance is every ledger entry before the period. Partner transfers move cash between partners and do not change the total.',
    'In the cash flow a loan is shown gross: the full loan amount under "Loans disbursed (full amount)" and the document charge kept back under "Document charges (kept back from loans)"; together they are the cash the borrower received. The profit & loss takes the document charge from the loans, not from these cash entries, so it is counted once.',
    'Periods follow the Indian financial year (1 April to 31 March), with entries dated by their Indian (IST) calendar date. A running period runs to the as-of date on the Summary.',
    'Amounts are in Indian rupees to the paisa. Totals are the app\'s own figures, written as values (not spreadsheet formulas), so they equal the screen.',
    'This is a supporting statement prepared from the app\'s records. It is not a tax computation.',
    ...report.notes,
  ];
}

function addNotes(wb: ExcelJS.Workbook, report: ItrReport): void {
  const ws = wb.addWorksheet(ITR_SHEETS.notes, {
    pageSetup: { paperSize: A4, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    headerFooter: { oddFooter: footer(ITR_SHEETS.notes) },
  });
  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 110;
  const title = ws.addRow([`How the figures are prepared: ${periodHeadline(report)}`]);
  title.getCell(1).font = { bold: true, size: 13 };
  ws.addRow([]);
  itrExportNotes(report).forEach((text, i) => {
    const row = ws.addRow([i + 1, text]);
    row.getCell(1).alignment = { vertical: 'top', horizontal: 'right' };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.height = Math.max(1, Math.ceil(text.length / 105)) * 15 + 2;
  });
}

// ---------------------------------------------------------------------------

export function buildItrReportWorkbook(report: ItrReport, options: ItrExcelOptions): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = ITR_EXPORT_BUSINESS_NAME;
  wb.created = options.generatedAt;
  wb.title = `Tax report ${report.period.label} ${report.period.scope}`;

  const sheets = itrExportSheetNames(report.period.scope);
  const partnerName = partnerNamer(report, options);
  for (const name of sheets) {
    switch (name) {
      case ITR_SHEETS.summary: addSummary(wb, report, options, sheets); break;
      case ITR_SHEETS.profitAndLoss: addProfitAndLoss(wb, report); break;
      case ITR_SHEETS.cashFlow: addCashFlow(wb, report); break;
      case ITR_SHEETS.chitPayouts: addChitPayouts(wb, report); break;
      case ITR_SHEETS.loanIncome: addLoanIncome(wb, report); break;
      case ITR_SHEETS.manualEntries: addManualEntries(wb, report, partnerName); break;
      case ITR_SHEETS.badDebts: addBadDebts(wb, report); break;
      case ITR_SHEETS.ledger: addLedger(wb, report, partnerName); break;
      case ITR_SHEETS.notes: addNotes(wb, report); break;
    }
  }
  return wb;
}

/** The workbook as .xlsx bytes. */
export async function buildItrReportXlsx(report: ItrReport, options: ItrExcelOptions): Promise<Buffer> {
  const data = await buildItrReportWorkbook(report, options).xlsx.writeBuffer();
  return Buffer.from(data as ArrayBuffer);
}
