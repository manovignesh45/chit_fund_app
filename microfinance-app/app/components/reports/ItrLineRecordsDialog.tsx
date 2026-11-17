'use client';

/**
 * The records behind one line of the tax report (GET /api/reports/itr?…&section=…&line=…):
 * date, description, amount, and per kind the useful extras (fund and payout for a chit margin,
 * loan type and repayments for interest, category and partner for ledger entries). Dialog on
 * desktop, bottom sheet on phones. Read only when opened; long lists show 100 at a time.
 */
import * as React from 'react';
import Link from 'next/link';

import type { ItrRecord } from '@/lib/itrReport';
import type { ItrLineSection } from '@/lib/itrReportView';
import { useItrLineRecords, type ItrReportParams } from '@/lib/query/reports';
import { recordAmountCategoryLabel } from '@/lib/transactionValidation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DateText } from '@/components/kit/date-text';
import { EmptyState } from '@/components/kit/empty-state';
import { ErrorState } from '@/components/kit/error-state';
import { Money } from '@/components/kit/money';
import { ResponsiveDialog } from '@/components/kit/responsive-dialog';

export interface OpenLine {
  section: ItrLineSection;
  key: string;
  label: string;
  /** From the summary, so the title is right before the records arrive. */
  recordCount: number;
  total: number | null;
}

const PAGE = 100;

const LOAN_TYPE: Record<string, string> = { monthly: 'Monthly loan', weekly: 'Weekly loan', reducingBalance: 'Reducing Balance loan' };
const LEDGER_TYPE: Record<string, string> = {
  CHIT_CONTRIBUTION: 'Chit contribution',
  LOAN_REPAYMENT: 'Loan repayment',
  loan_repaid: 'Loan repayment',
  DOCUMENT_CHARGE: 'Document charge',
  AUCTION_PAYOUT: 'Auction payout',
  LOAN_DISBURSEMENT: 'Loan disbursement',
  loan_given: 'Loan disbursement',
  RECORD_AMOUNT: 'Record Amount',
  PARTNER_TO_PARTNER: 'Partner transfer',
  transfer: 'Partner transfer',
};

/** Money with paise only when the amount has them. */
export const decimalsOf = (value: number | null | undefined) => (value != null && Math.round(value * 100) % 100 !== 0 ? 2 : 0);

function Extras({ record: r, partnerNames }: { record: ItrRecord; partnerNames: ReadonlyMap<number, string> }) {
  const bits: React.ReactNode[] = [];
  const link = (href: string, text: string) => (
    <Link key={href} href={href} className="font-medium text-primary-text underline-offset-2 hover:underline">
      {text}
    </Link>
  );
  switch (r.kind) {
    case 'chitPayout':
      bits.push(<span key="payout">Payout <Money value={r.payout} decimals={decimalsOf(r.payout)} /></span>);
      bits.push(<span key="term">Term contribution <Money value={r.termContribution} decimals={decimalsOf(r.termContribution)} /></span>);
      if (r.fundId) bits.push(link(`/chit-funds/${r.fundId}?tab=auctions`, 'Open fund'));
      break;
    case 'loanInterest':
      if (r.loanType) bits.push(<span key="type">{LOAN_TYPE[r.loanType] ?? r.loanType}</span>);
      bits.push(<span key="count">{r.repaymentCount ?? 0} {r.repaymentCount === 1 ? 'repayment' : 'repayments'} in the period</span>);
      if (r.loanId) bits.push(link(`/loans/${r.loanId}`, 'Open loan'));
      break;
    case 'documentCharge':
    case 'badDebtRecovered':
      if (r.loanType) bits.push(<span key="type">{LOAN_TYPE[r.loanType] ?? r.loanType}</span>);
      if (r.loanId) bits.push(link(`/loans/${r.loanId}`, 'Open loan'));
      break;
    case 'badDebtWrittenOff':
      bits.push(<span key="out">Outstanding now <Money value={r.outstanding} decimals={decimalsOf(r.outstanding)} /></span>);
      if (r.loanId) bits.push(link(`/loans/${r.loanId}`, 'Open loan'));
      break;
    case 'ledger': {
      bits.push(<span key="type">{LEDGER_TYPE[r.type ?? ''] ?? r.type}</span>);
      if (r.type === 'RECORD_AMOUNT') bits.push(<span key="cat">{recordAmountCategoryLabel(r.category)}</span>);
      const partner = r.partnerId != null ? partnerNames.get(r.partnerId) : null;
      if (partner) bits.push(<span key="partner">{partner}</span>);
      bits.push(link(`/transactions?txn=${r.id}`, `Entry #${r.id}`));
      break;
    }
  }
  return (
    <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {bits.map((bit, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          {bit}
        </React.Fragment>
      ))}
    </p>
  );
}

export function ItrLineRecordsDialog({
  params,
  line,
  onClose,
  partnerNames,
}: {
  params: ItrReportParams;
  line: OpenLine | null;
  onClose: () => void;
  partnerNames: ReadonlyMap<number, string>;
}) {
  // Keep the last line while the dialog animates closed.
  const [shown, setShown] = React.useState<OpenLine | null>(line);
  React.useEffect(() => {
    if (line) setShown(line);
  }, [line]);
  const [limit, setLimit] = React.useState(PAGE);
  React.useEffect(() => setLimit(PAGE), [line?.section, line?.key]);

  const query = useItrLineRecords(line ? params : null, line ? { section: line.section, line: line.key } : null);
  const current = shown;
  // SWR keeps the previous key's data while a new key loads: never show another line's records.
  const data = query.data && current && query.data.line.section === current.section && query.data.line.key === current.key ? query.data : undefined;
  const records = data?.line.records ?? [];

  let body: React.ReactNode;
  if (!data && query.error) {
    body = <ErrorState compact title="Couldn't load the records" error={query.error} onRetry={() => void query.mutate()} retrying={query.isValidating} />;
  } else if (!data) {
    body = (
      <div className="space-y-3" role="status" aria-label="Loading records">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    );
  } else if (records.length === 0) {
    body = <EmptyState compact title="No records" description="Nothing in this period makes up this line." />;
  } else {
    body = (
      <div className="space-y-3">
        <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-md border" aria-label={`Records: ${current?.label ?? ''}`}>
          {records.slice(0, limit).map((r) => (
            <li key={`${r.kind}-${r.id}`} className="flex items-start justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm text-foreground">
                  {r.date ? <DateText value={r.date} className="text-muted-foreground" /> : <span className="text-muted-foreground">Whole period</span>}
                  <span className="text-muted-foreground"> · </span>
                  <span className="break-words">{r.description}</span>
                </p>
                <Extras record={r} partnerNames={partnerNames} />
              </div>
              <Money value={r.amount} decimals={decimalsOf(r.amount)} className="shrink-0 text-sm font-medium" />
            </li>
          ))}
        </ul>
        {records.length > limit ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              Showing {limit.toLocaleString('en-IN')} of {records.length.toLocaleString('en-IN')}
            </span>
            <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, records.length - limit)} more
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const count = data ? records.length : current?.recordCount ?? 0;
  const total = data ? data.line.total : current?.total ?? null;
  return (
    <ResponsiveDialog
      open={line !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      title={current?.section === 'warning' ? 'Entries behind this warning' : current?.label ?? 'Records'}
      description={
        <>
          {count.toLocaleString('en-IN')} {count === 1 ? 'record' : 'records'}
          {total !== null ? (
            <>
              {' · total '}
              <Money value={total} decimals={decimalsOf(total)} tone="plain" />
            </>
          ) : null}
        </>
      }
    >
      {body}
    </ResponsiveDialog>
  );
}
