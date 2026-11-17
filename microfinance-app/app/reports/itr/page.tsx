'use client';

/**
 * Tax report (Report template): profit & loss, cash flow and partner share for a fiscal period.
 * Year, period and scope live in the URL (`?fy=2025&period=H1&scope=loans`; defaults: current
 * year, full year, all). Every figure comes from GET /api/reports/itr (lib/itrReport.ts); this
 * page only lays them out. A line opens the records behind it.
 */
import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, CalendarClock, ChevronRight, Info, ReceiptText } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatDate, formatMoney } from '@/lib/format';
import { useUrlState } from '@/lib/list/useUrlState';
import { FISCAL_PERIOD_KEYS, fiscalYearLabel, type FiscalPeriodKey } from '@/lib/fiscalPeriods';
import type { ItrScope, ItrSeries } from '@/lib/itrReport';
import type { ItrLineSummary, ItrReportResponse, ItrReportView, ItrWarningSummary } from '@/lib/itrReportView';
import { useItrReport, type ItrReportParams } from '@/lib/query/reports';
import { DataTable, RefreshProgress, type DataTableColumn } from '@/components/kit/data-table';
import { DateText } from '@/components/kit/date-text';
import { EmptyState } from '@/components/kit/empty-state';
import { ErrorState } from '@/components/kit/error-state';
import { Money } from '@/components/kit/money';
import { NativeSelect } from '@/components/kit/native-select';
import { PageContainer } from '@/components/kit/page-container';
import { PageHeader } from '@/components/kit/page-header';
import { SegmentedControl } from '@/components/kit/period-picker';
import { SectionCard } from '@/components/kit/section-card';
import { StatCard } from '@/components/kit/stat-card';
import ClassifyEntriesPanel from '@/app/components/reports/ClassifyEntriesPanel';
import { decimalsOf, ItrLineRecordsDialog, type OpenLine } from '@/app/components/reports/ItrLineRecordsDialog';

const PERIOD_OPTIONS: { value: FiscalPeriodKey; label: string }[] = FISCAL_PERIOD_KEYS.map((key) => ({ value: key, label: key === 'FY' ? 'Full year' : key }));
const SCOPE_OPTIONS: { value: ItrScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'chits', label: 'Chits' },
  { value: 'loans', label: 'Loans' },
];
const isPeriod = (v: string): v is FiscalPeriodKey => (FISCAL_PERIOD_KEYS as readonly string[]).includes(v);
const isScope = (v: string): v is ItrScope => v === 'all' || v === 'chits' || v === 'loans';

export default function TaxReportPage() {
  return (
    <PageContainer>
      <TaxReport />
    </PageContainer>
  );
}

// ─────────────────────────────────────────────────────────────── statement rows

type RowKind = 'heading' | 'line' | 'total' | 'result' | 'balance' | 'memo';

interface StatementRow {
  id: string;
  kind: RowKind;
  label: string;
  total: number | null;
  months: (number | null)[];
  open?: OpenLine;
}

const allZero = (s: ItrSeries) => s.total === 0 && s.months.every((m) => m === 0);

function lineRows(section: 'pl' | 'cash', lines: ItrLineSummary[]): StatementRow[] {
  return lines
    .filter((l) => !allZero(l))
    .map((l) => ({
      id: `${section}:${l.key}`,
      kind: 'line',
      label: l.label,
      total: l.total,
      months: l.months,
      open: l.recordCount > 0 ? { section, key: l.key, label: l.label, recordCount: l.recordCount, total: l.total } : undefined,
    }));
}

const heading = (id: string, label: string, monthCount: number): StatementRow => ({ id, kind: 'heading', label, total: null, months: Array(monthCount).fill(null) });
const seriesRow = (id: string, kind: RowKind, label: string, s: ItrSeries): StatementRow => ({ id, kind, label, total: s.total, months: s.months });

function profitAndLossRows(report: ItrReportView): StatementRow[] {
  const pl = report.profitAndLoss;
  const n = report.months.length;
  const rows: StatementRow[] = [heading('h-income', 'Income', n), ...lineRows('pl', pl.income), seriesRow('total-income', 'total', 'Total income', pl.totalIncome)];
  // Chits scope has no expense lines at all (shared expenses are not allocated to it).
  if (pl.expenses.length) {
    rows.push(heading('h-expenses', 'Expenses', n), ...lineRows('pl', pl.expenses), seriesRow('total-expenses', 'total', 'Total expenses', pl.totalExpenses));
  }
  rows.push(seriesRow('net-profit', 'result', 'Net profit', pl.netProfit));
  return rows;
}

function cashFlowRows(report: ItrReportView): StatementRow[] {
  const cf = report.cashFlow;
  const n = report.months.length;
  const rows: StatementRow[] = [];
  if (!cf.pooled && cf.opening !== null && cf.closingByMonth) {
    // Each month opens with the previous month's closing balance.
    rows.push({ id: 'opening', kind: 'balance', label: 'Opening balance', total: cf.opening, months: [cf.opening, ...cf.closingByMonth.slice(0, -1)].slice(0, n) });
  }
  rows.push(heading('h-receipts', 'Receipts', n), ...lineRows('cash', cf.receipts), seriesRow('total-receipts', 'total', 'Total receipts', cf.totalReceipts));
  rows.push(heading('h-payments', 'Payments', n), ...lineRows('cash', cf.payments), seriesRow('total-payments', 'total', 'Total payments', cf.totalPayments));
  rows.push(seriesRow('net-movement', 'result', 'Net cash movement', cf.netMovement));
  if (!cf.pooled && cf.closing !== null && cf.closingByMonth) {
    rows.push({ id: 'closing', kind: 'balance', label: 'Closing balance', total: cf.closing, months: cf.closingByMonth });
  }
  if (cf.transfers) {
    const t = cf.transfers;
    rows.push({
      id: 'cash:partnerTransfers',
      kind: 'memo',
      label: t.label,
      total: t.total,
      months: t.months,
      open: t.recordCount > 0 ? { section: 'cash', key: t.key, label: t.label, recordCount: t.recordCount, total: t.total } : undefined,
    });
  }
  return rows;
}

const ROW_CLASS: Partial<Record<RowKind, string>> = {
  heading: 'bg-muted hover:bg-muted [&>td:first-child]:bg-muted [&>td]:py-1.5 [&>td]:text-xs [&>td]:font-semibold [&>td]:uppercase [&>td]:tracking-wide [&>td]:text-muted-foreground',
  total: 'font-semibold',
  result: 'bg-elevated font-semibold [&>td:first-child]:bg-elevated',
  balance: 'bg-elevated font-medium [&>td:first-child]:bg-elevated',
  memo: 'italic text-muted-foreground',
};

/** The first column stays put while the months scroll sideways, at every width (SPEC "grids scroll sideways with a sticky first column"). */
const STICKY_CELL = 'min-w-[10rem] max-w-[12rem] whitespace-normal sm:min-w-[14rem] sm:max-w-[17rem] md:sticky md:left-0 md:z-10 md:bg-card md:group-hover:bg-elevated';
const STICKY_HEAD = 'md:sticky md:left-0 md:z-20 md:bg-elevated';

function StatementTable({
  label,
  report,
  rows,
  loading,
  refreshing,
  onOpen,
}: {
  label: string;
  report: ItrReportView | undefined;
  rows: StatementRow[];
  loading: boolean;
  refreshing: boolean;
  onOpen: (line: OpenLine) => void;
}) {
  const months = report?.months ?? [];
  const money = (value: number | null) => (value === null ? null : <Money value={value} decimals={decimalsOf(value)} />);
  const columns: DataTableColumn<StatementRow>[] = [
    {
      id: 'label',
      header: 'Line',
      className: STICKY_CELL,
      headerClassName: STICKY_HEAD,
      cell: (row) =>
        row.open ? (
          <button
            type="button"
            onClick={() => onOpen(row.open!)}
            className="-mx-1 inline-flex items-start gap-1 rounded-sm px-1 text-left text-primary-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>{row.label}</span>
            <ChevronRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="sr-only">
              , show {row.open.recordCount} {row.open.recordCount === 1 ? 'record' : 'records'}
            </span>
          </button>
        ) : (
          <span>{row.label}</span>
        ),
    },
    ...months.map<DataTableColumn<StatementRow>>((m, i) => ({
      id: `m-${m.key}`,
      header: m.label,
      numeric: true,
      cell: (row) => money(row.months[i] ?? null),
    })),
    { id: 'total', header: months.length > 1 ? 'Total' : 'Amount', numeric: true, cell: (row) => <span className="font-semibold">{money(row.total)}</span> },
  ];
  return (
    <DataTable<StatementRow>
      label={label}
      mode="client"
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      isInitialLoading={loading}
      isRefreshing={refreshing}
      skeletonRows={8}
      rowClassName={(row) => ROW_CLASS[row.kind]}
    />
  );
}

// ─────────────────────────────────────────────────────────────── warnings

function WarningList({
  warnings,
  onOpen,
}: {
  warnings: ItrWarningSummary[];
  onOpen: (line: OpenLine) => void;
}) {
  if (!warnings.length) return null;
  const view = (w: ItrWarningSummary, text: string) =>
    w.recordCount > 0 ? (
      <button
        type="button"
        className="font-medium text-foreground underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpen({ section: 'warning', key: w.code, label: text, recordCount: w.recordCount, total: w.amount ?? null })}
      >
        {text}
      </button>
    ) : null;
  const amount = (w: ItrWarningSummary) => (w.amount != null ? <Money value={w.amount} decimals={decimalsOf(w.amount)} tone="plain" /> : null);

  return (
    <ul className="space-y-2" aria-label="Report warnings">
      {warnings.map((w) => {
        let body: React.ReactNode;
        let tone: 'warning' | 'info' = 'warning';
        switch (w.code) {
          case 'UNCLASSIFIED_ENTRIES':
            body = (
              <>
                {w.count} manual {w.count === 1 ? 'entry' : 'entries'} in this period ({amount(w)}) {w.count === 1 ? 'has' : 'have'} no category, so{' '}
                {w.count === 1 ? 'it is' : 'they are'} left out of the profit &amp; loss. {view(w, 'See the entries')}
                {' · '}
                <a href="#classify-entries" className="font-medium text-foreground underline underline-offset-2 hover:no-underline">
                  Classify them below
                </a>
              </>
            );
            break;
          case 'DOCUMENT_CHARGE_LEDGER':
            body = (
              <>
                {w.count} document-charge ledger {w.count === 1 ? 'entry' : 'entries'} ({amount(w)}) {w.count === 1 ? 'is' : 'are'} under review. The charge is already kept
                back from each loan, so these entries may count it twice. They are shown on their own cash line so the closing balance still matches the app&apos;s
                Total balance; the profit &amp; loss takes the charge from the loans. {view(w, 'See the entries')}
                {' · '}
                <Link href="/dashboard" className="font-medium text-foreground underline underline-offset-2 hover:no-underline">
                  Amount flow tally on the Dashboard
                </Link>
              </>
            );
            break;
          case 'NEGATIVE_OPENING_CASH':
            body = <>Cash at the start of this period is negative ({amount(w)}): more was paid out than was recorded coming in before it. The difference was funded outside the ledger.</>;
            break;
          case 'NEGATIVE_CLOSING_CASH':
            body = <>Cash at the end of this period is negative ({amount(w)}): more was paid out than was recorded coming in. The difference was funded outside the ledger.</>;
            break;
          case 'PERIOD_RUNNING':
            tone = 'info';
            body = <>This period is still running. The figures are to date and will change as entries are added.</>;
            break;
          default:
            body = w.message;
        }
        const Icon = tone === 'info' ? Info : AlertTriangle;
        return (
          <li
            key={w.code}
            className={cn(
              'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
              tone === 'info' ? 'border-info-border bg-info-subtle text-info-text' : 'border-warning-border bg-warning-subtle text-warning-text'
            )}
          >
            <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0">{body}</p>
          </li>
        );
      })}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────── partners

function PartnerPanel({ report }: { report: ItrReportView }) {
  const shares = new Map((report.partnerShare?.partners ?? []).map((p) => [p.partnerId, p.share]));
  const partners = report.cashFlow.partners;
  if (!partners.length) return null;
  const amount = (value: number) => <Money value={value} decimals={decimalsOf(value)} tone="auto" />;
  return (
    <SectionCard title="Partners" description={`Profit is shared equally. Cash held is each partner's own ledger balance.`}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {partners.map((p) => {
          const share = p.partnerId !== null ? shares.get(p.partnerId) : undefined;
          const rows: [string, React.ReactNode][] = [
            ['Opening cash', amount(p.opening)],
            ['Received', amount(p.in)],
            ['Paid out', amount(-p.out)],
            ['Transfers in', amount(p.transfersIn)],
            ['Transfers out', amount(-p.transfersOut)],
          ];
          return (
            <section key={p.partnerId ?? 'unassigned'} aria-label={p.name} className="rounded-lg border p-4">
              <h3 className="font-semibold text-foreground">{p.name}</h3>
              {p.partnerId === null ? (
                <p className="mt-0.5 text-xs text-muted-foreground">Entries that name no partner on that side.</p>
              ) : null}
              <dl className="mt-3 space-y-1.5 text-sm">
                {share !== undefined ? (
                  <div className="flex items-center justify-between gap-3 border-b pb-2">
                    <dt className="text-muted-foreground">Profit share</dt>
                    <dd className="font-semibold">{amount(share)}</dd>
                  </div>
                ) : null}
                {rows.map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-3 border-t pt-2">
                  <dt className="font-medium text-foreground">Cash held at the end</dt>
                  <dd className="font-semibold">{amount(p.closing)}</dd>
                </div>
              </dl>
            </section>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────── page

function hasAnything(report: ItrReportView): boolean {
  const lines = [...report.profitAndLoss.income, ...report.profitAndLoss.expenses, ...report.cashFlow.receipts, ...report.cashFlow.payments];
  return lines.some((l) => l.recordCount > 0 || !allZero(l)) || (report.cashFlow.transfers?.recordCount ?? 0) > 0 || (report.cashFlow.opening ?? 0) !== 0;
}

function TaxReport() {
  const url = useUrlState({ fy: '', period: 'FY', scope: 'all' });
  const fyParam = /^\d{4}$/.test(url.values.fy) ? url.values.fy : '';
  const period: FiscalPeriodKey = isPeriod(url.values.period) ? url.values.period : 'FY';
  const scope: ItrScope = isScope(url.values.scope) ? url.values.scope : 'all';
  const params: ItrReportParams = React.useMemo(
    () => ({ fy: fyParam || undefined, period: period === 'FY' ? undefined : period, scope: scope === 'all' ? undefined : scope }),
    [fyParam, period, scope]
  );
  const query = useItrReport(url.ready ? params : null);
  const data: ItrReportResponse | undefined = query.data;
  const report = data?.report;
  const loaded = report !== undefined;
  const refreshing = loaded && query.isLoading;
  const [openLine, setOpenLine] = React.useState<OpenLine | null>(null);

  const selectedFy = fyParam ? Number(fyParam) : report?.period.fy ?? null;
  const currentFy = data?.fiscalYears.find((y) => y.running)?.fy ?? null;
  const fyOptions = React.useMemo(() => {
    const options = (data?.fiscalYears ?? []).map((y) => ({ value: String(y.fy), label: y.running ? `${y.label} (to date)` : y.label }));
    // A year from the URL with no records still shows as chosen.
    if (selectedFy !== null && !options.some((o) => o.value === String(selectedFy))) {
      options.push({ value: String(selectedFy), label: fiscalYearLabel(selectedFy) });
      options.sort((a, b) => Number(b.value) - Number(a.value));
    }
    return options;
  }, [data?.fiscalYears, selectedFy]);

  const partnerNames = React.useMemo(
    () => new Map((report?.cashFlow.partners ?? []).flatMap((p) => (p.partnerId !== null ? [[p.partnerId, p.name] as const] : []))),
    [report]
  );
  const plRows = React.useMemo(() => (report ? profitAndLossRows(report) : []), [report]);
  const cashRows = React.useMemo(() => (report ? cashFlowRows(report) : []), [report]);

  const periodText = report ? (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>
        {report.period.label}
        {report.period.period !== 'FY' ? ` · ${report.period.fiscalYearLabel}` : ''} · {report.period.filingYearLabel}
      </span>
      {report.period.status === 'running' && report.period.asOf ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-info-border bg-info-subtle px-2 py-0.5 text-xs font-medium text-info-text">
          <CalendarClock aria-hidden="true" className="h-3 w-3" />
          To date, as of <DateText value={report.period.asOf} />
        </span>
      ) : null}
    </span>
  ) : (
    // The header description is a <p>: no <div> (Skeleton) inside it.
    <span aria-hidden="true" className="inline-block h-4 w-56 max-w-full animate-pulse rounded-md bg-muted align-middle" />
  );

  const scopeName = scope === 'chits' ? 'Chits' : scope === 'loans' ? 'Loans' : null;
  const pooled = report?.cashFlow.pooled ?? scope !== 'all';
  const notStarted = report?.period.status === 'not-started';
  const empty = report ? notStarted || !hasAnything(report) : false;

  return (
    <div>
      <PageHeader
        title="Tax report"
        description={periodText}
        actionsLayout="stack"
        actions={
          // Phase 4 adds the Excel export button here, after the controls.
          <>
            <NativeSelect
              aria-label="Financial year"
              size="sm"
              className="min-w-[11rem]"
              value={selectedFy !== null ? String(selectedFy) : ''}
              options={fyOptions}
              disabled={!data}
              onValueChange={(value) => url.set({ fy: Number(value) === currentFy ? null : value })}
            />
            <SegmentedControl aria-label="Period" size="sm" value={period} onChange={(next) => url.set({ period: next === 'FY' ? null : next })} options={PERIOD_OPTIONS} />
            <SegmentedControl aria-label="Scope" size="sm" value={scope} onChange={(next) => url.set({ scope: next === 'all' ? null : next })} options={SCOPE_OPTIONS} />
          </>
        }
      />

      {query.error && !loaded ? (
        <ErrorState title="Couldn't load the tax report" error={query.error} onRetry={() => void query.mutate()} retrying={query.isValidating} />
      ) : (
        <div className="relative space-y-6" aria-busy={refreshing || undefined}>
          <RefreshProgress active={refreshing} />

          {report && report.warnings.length ? <WarningList warnings={report.warnings} onOpen={setOpenLine} /> : null}

          {report && !report.sharedItemsAllocated ? (
            <div className="flex items-start gap-2.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium text-foreground">{scopeName} only: shared items are not allocated.</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {report.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {empty && report ? (
            <EmptyState
              icon={ReceiptText}
              title={notStarted ? `${report.period.label} has not started yet` : `No records in ${report.period.label}`}
              description={
                notStarted
                  ? `It starts on ${formatDate(report.period.start)}. Choose an earlier period.`
                  : 'Nothing was recorded in this period for this scope. Choose another year or period.'
              }
            />
          ) : (
            <>
              <section
                aria-label="Key figures"
                className={cn('grid grid-cols-2 gap-3', pooled ? 'lg:grid-cols-4' : 'sm:grid-cols-3 lg:grid-cols-5')}
              >
                {pooled ? (
                  <>
                    <StatCard loading={!loaded} label={`Net profit (${scopeName})`} value={report ? <Money value={report.profitAndLoss.netProfit.total} tone="auto" /> : null} hint="Before shared expenses" />
                    <StatCard loading={!loaded} label="Total income" value={report ? <Money value={report.profitAndLoss.totalIncome.total} tone="auto" /> : null} />
                    <StatCard loading={!loaded} label="Total receipts" value={report ? <Money value={report.cashFlow.totalReceipts.total} tone="auto" /> : null} hint={`Payments ${report ? formatMoney(report.cashFlow.totalPayments.total) : ''}`} />
                    <StatCard loading={!loaded} label="Net cash movement" value={report ? <Money value={report.cashFlow.netMovement.total} tone="auto" /> : null} hint="Receipts − payments" />
                  </>
                ) : (
                  <>
                    <StatCard className="col-span-2 sm:col-span-1" loading={!loaded} label="Net profit" value={report ? <Money value={report.profitAndLoss.netProfit.total} tone="auto" /> : null} hint="Income − expenses" />
                    {(report?.partnerShare?.partners ?? [{ partnerId: -1, name: 'Partner', share: 0 }, { partnerId: -2, name: 'Partner', share: 0 }]).map((p) => (
                      <StatCard key={p.partnerId} loading={!loaded} label={`${p.name}'s share`} value={<Money value={p.share} tone="auto" />} hint="Equal share" />
                    ))}
                    <StatCard loading={!loaded} label="Net cash movement" value={report ? <Money value={report.cashFlow.netMovement.total} tone="auto" /> : null} hint="Receipts − payments" />
                    <StatCard loading={!loaded} label="Closing cash" value={report ? <Money value={report.cashFlow.closing} tone="auto" /> : null} hint="Total balance at the end" />
                  </>
                )}
              </section>

              <section aria-labelledby="itr-pl" className="space-y-3">
                <div>
                  <h2 id="itr-pl" className="text-base font-semibold text-foreground">
                    Profit &amp; loss
                  </h2>
                  <p className="text-sm text-muted-foreground">Chit margin is counted at payout; loan interest as it is received. Open a line for its records.</p>
                </div>
                <StatementTable label="Profit and loss" report={report} rows={plRows} loading={!loaded} refreshing={refreshing} onOpen={setOpenLine} />
              </section>

              <section aria-labelledby="itr-cash" className="space-y-3">
                <div>
                  <h2 id="itr-cash" className="text-base font-semibold text-foreground">
                    Cash flow
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {pooled ? 'Receipts and payments of this line of business; cash is pooled, so there is no opening or closing balance.' : 'From the cash ledger. Partner transfers move cash between partners and do not change the total.'}
                  </p>
                </div>
                <StatementTable label="Cash flow" report={report} rows={cashRows} loading={!loaded} refreshing={refreshing} onOpen={setOpenLine} />
              </section>

              {report && !pooled ? <PartnerPanel report={report} /> : null}
            </>
          )}

          {scope === 'all' ? (
            <div id="classify-entries" className="scroll-mt-20">
              <ClassifyEntriesPanel onChanged={() => void query.mutate()} />
            </div>
          ) : null}
        </div>
      )}

      <ItrLineRecordsDialog params={params} line={openLine} onClose={() => setOpenLine(null)} partnerNames={partnerNames} />
    </div>
  );
}
