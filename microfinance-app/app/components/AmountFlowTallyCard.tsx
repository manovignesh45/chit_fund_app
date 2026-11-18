'use client';

/**
 * Amount flow tally (dashboard Overview): checks
 *   Invested (net) + Cash inflow = Cash outflow + Total balance
 * by putting the business records next to the cash ledger. The headline shows the records'
 * expected balance against the ledger's Total balance (the Partner-wise balance panel's
 * figure); the breakdown shows every category and the loans whose ledger entries are not the
 * gross pair (full loan amount disbursed + document charge entered back).
 * Data: GET /dashboard/consolidated?action=amount-flow-tally.
 */
import * as React from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { useAmountFlowTally, type AmountFlowTally, type TallyLoanDetail, type TallyRow } from '@/lib/query/dashboard';
import { Skeleton } from '@/components/ui/skeleton';
import { DateText } from '@/components/kit/date-text';
import { DescriptionList } from '@/components/kit/description-list';
import { ErrorState } from '@/components/kit/error-state';
import { Money } from '@/components/kit/money';
import { SectionCard } from '@/components/kit/section-card';
import { StatusBadge } from '@/components/kit/status-badge';

const off = (n: number | null | undefined) => n !== null && n !== undefined && Math.abs(n) >= 1;

export default function AmountFlowTallyCard({ className }: { className?: string }) {
  const query = useAmountFlowTally();
  const tally = query.data;
  return (
    <SectionCard
      title="Amount flow tally"
      description="Invested + cash inflow = cash outflow + total balance"
      className={className}
      actions={
        tally ? (
          tally.tallied ? (
            <StatusBadge status="Paid" label="Tallied" />
          ) : (
            <StatusBadge status="Overdue" label="Mismatch" />
          )
        ) : null
      }
    >
      {!tally ? (
        query.error ? (
          <ErrorState compact title="Couldn't load the amount flow tally" error={query.error} onRetry={() => void query.mutate()} />
        ) : (
          <div aria-hidden="true" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-6 w-28" />
              </div>
            ))}
          </div>
        )
      ) : (
        <TallyBody tally={tally} />
      )}
    </SectionCard>
  );
}

function TallyBody({ tally }: { tally: AmountFlowTally }) {
  const mismatchCount = tally.rows.filter((r) => off(r.difference)).length;
  return (
    <div className="space-y-4">
      <DescriptionList
        columns={4}
        items={[
          { label: 'Money in', value: <Money value={tally.moneyIn.records} tone="plain" className="text-lg font-semibold" />, hint: 'Invested + cash inflow + document charges kept back' },
          { label: 'Money out', value: <Money value={tally.moneyOut.records} tone="plain" className="text-lg font-semibold" />, hint: 'Cash outflow, with loans at their full amount' },
          { label: 'Expected balance', value: <Money value={tally.recordsExpectedBalance} tone="auto" className="text-lg font-semibold" />, hint: 'Money in − money out' },
          { label: 'Actual balance (ledger)', value: <Money value={tally.ledgerBalance} tone="auto" className="text-lg font-semibold" />, hint: 'Total balance of all partners' },
          {
            full: true,
            label: 'Difference',
            value: tally.tallied ? (
              <span className="text-lg font-semibold text-success-text">Tallied</span>
            ) : (
              <Money value={tally.difference} tone="loss" className="text-lg font-semibold" />
            ),
            hint: tally.tallied
              ? 'The ledger balance matches what the records explain.'
              : `Actual − expected. ${tally.difference > 0 ? 'The ledger holds more cash than the records explain.' : 'The ledger holds less cash than the records explain.'}`,
          },
        ]}
      />

      <LedgerFlags tally={tally} />

      <details className="group border-t pt-3 text-sm">
        <summary className="cursor-pointer rounded-sm font-medium text-primary-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Show breakdown{mismatchCount ? ` (${mismatchCount} ${mismatchCount === 1 ? 'row differs' : 'rows differ'})` : ''}
        </summary>
        <div className="mt-3 space-y-5">
          <CategoryTable tally={tally} />
          <LoanDrillDown loans={tally.loanDetails} />
          <UnmatchedCharges tally={tally} />
        </div>
      </details>
    </div>
  );
}

/** Ledger-internal checks: per-type sums vs partner balances, and the stored running balance. */
function LedgerFlags({ tally }: { tally: AmountFlowTally }) {
  const flags: React.ReactNode[] = [];
  if (off(tally.ledgerComputedDifference)) {
    flags.push(
      <>
        Ledger entries by type add up to <Money value={tally.ledgerComputedBalance} tone="plain" />, but the partner balances total{' '}
        <Money value={tally.ledgerBalance} tone="plain" />. Some entries are missing a partner or have an unexpected direction.
      </>
    );
  }
  if (tally.runningBalance !== null && off(tally.runningBalanceDifference)) {
    flags.push(
      <>
        The running balance stored on the latest entry is <Money value={tally.runningBalance} tone="plain" />, not{' '}
        <Money value={tally.ledgerBalance} tone="plain" />. The stored running balances are stale.
      </>
    );
  }
  if (!flags.length) return null;
  return (
    <ul className="space-y-2">
      {flags.map((flag, i) => (
        <li key={i} className="rounded-md border border-warning-border bg-warning-subtle p-3 text-sm text-warning-text">
          {flag}
        </li>
      ))}
    </ul>
  );
}

function CategoryTable({ tally }: { tally: AmountFlowTally }) {
  const groups: { title: string; dir: TallyRow['direction']; total: { records: number; ledger: number } }[] = [
    { title: 'Money in', dir: 'in', total: tally.moneyIn },
    { title: 'Money out', dir: 'out', total: tally.moneyOut },
  ];
  const cell = 'px-3 py-2 text-right';
  return (
    <div>
      <div className="-mx-4 overflow-x-auto sm:mx-0 sm:rounded-lg sm:border">
        <table className="w-full min-w-[22rem] text-sm">
          <caption className="sr-only">Records against the cash ledger, by category</caption>
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Category</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Records</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Ledger</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Difference</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.dir}>
              <tr className="border-t bg-muted/30">
                <th scope="colgroup" colSpan={4} className="px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </th>
              </tr>
              {tally.rows
                .filter((r) => r.direction === group.dir)
                .map((r) => {
                  const mismatch = off(r.difference);
                  return (
                    <tr key={r.key} className={cn('border-t', mismatch && 'bg-destructive-subtle/50')}>
                      <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
                        {r.label}
                        {mismatch ? <span className="sr-only"> (differs)</span> : null}
                      </th>
                      <td className={cell}><Money value={r.records} tone="plain" /></td>
                      <td className={cell}><Money value={r.ledger} tone="plain" /></td>
                      <td className={cn(cell, 'font-medium')}>{mismatch ? <Money value={r.difference} tone="auto" /> : <Money value={0} />}</td>
                    </tr>
                  );
                })}
              <tr className="border-t font-medium">
                <th scope="row" className="px-3 py-2 text-left text-foreground">Total {group.title.toLowerCase()}</th>
                <td className={cell}><Money value={group.total.records} tone="plain" /></td>
                <td className={cell}><Money value={group.total.ledger} tone="plain" /></td>
                <td className={cell} />
              </tr>
            </tbody>
          ))}
          <tfoot>
            <tr className="border-t-2 bg-muted/40 font-semibold">
              <th scope="row" className="px-3 py-2 text-left text-foreground">Balance (in − out)</th>
              <td className={cell}><Money value={tally.recordsExpectedBalance} tone="auto" /></td>
              <td className={cell}><Money value={tally.ledgerComputedBalance} tone="auto" /></td>
              <td className={cell}>
                {off(tally.ledgerComputedBalance - tally.recordsExpectedBalance) ? (
                  <Money value={tally.ledgerComputedBalance - tally.recordsExpectedBalance} tone="auto" />
                ) : (
                  <Money value={0} />
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Difference is each row&apos;s effect on the balance: ledger − records for money in, records − ledger for money out. Loans are recorded
        gross: the full loan amount goes out and the document charge kept back comes back in, so together they equal the cash the borrower got.
      </p>
    </div>
  );
}

/** Expected ledger for a loan (gross): disbursed = loan amount, plus a document-charge entry = the charge. */
function loanReason(loan: TallyLoanDetail): string {
  const parts: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  if (loan.ledgerDisbursed === null) parts.push('No disbursement entry in the ledger.');
  else if (loan.documentCharge > 0 && near(loan.ledgerDisbursed, loan.cashGiven))
    parts.push('Ledger disbursement is the cash given (amount − charge), not the full loan amount.');
  else if (!near(loan.ledgerDisbursed, loan.amount)) parts.push('Ledger disbursement differs from the loan amount.');
  if (loan.documentCharge > 0 && loan.ledgerDocumentCharge === null) parts.push('No document charge entry for the charge kept back.');
  if (near(loan.difference, 0)) parts.push('The balance is not affected.');
  else parts.push(loan.difference > 0 ? 'The ledger balance is too high by this amount.' : 'The ledger balance is too low by this amount.');
  return parts.join(' ');
}

const LOAN_PREVIEW = 10;

function LoanDrillDown({ loans: all }: { loans: TallyLoanDetail[] }) {
  const [showAll, setShowAll] = React.useState(false);
  // Largest gaps first, so the loans that explain most of the difference are on top.
  const sorted = React.useMemo(() => [...all].sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)), [all]);
  const loans = showAll ? sorted : sorted.slice(0, LOAN_PREVIEW);
  const hidden = sorted.length - loans.length;
  return (
    <section aria-labelledby="tally-loans-title" className="space-y-2">
      <h3 id="tally-loans-title" className="text-sm font-semibold text-foreground">
        Loans that differ{sorted.length ? ` (${sorted.length})` : ''}
      </h3>
      {!sorted.length ? (
        <p className="text-sm text-muted-foreground">Every loan is in the ledger as the full amount disbursed plus its document charge entry.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {loans.map((loan) => (
            <li key={loan.id} className="space-y-1 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <Link href={`/loans/${loan.id}`} className="min-w-0 truncate font-medium text-primary-text underline-offset-2 hover:underline">
                  #{loan.id} {loan.borrower}
                </Link>
                <Money value={loan.difference} tone="auto" className="shrink-0 font-medium" />
              </div>
              <p className="text-xs text-muted-foreground">
                Loan <Money value={loan.amount} tone="plain" /> · Doc charge <Money value={loan.documentCharge} tone="plain" /> · Cash given{' '}
                <Money value={loan.cashGiven} tone="plain" />
              </p>
              <p className="text-xs text-muted-foreground">
                Ledger: disbursed <Money value={loan.ledgerDisbursed} fallback="none" tone="plain" /> · doc charge entry{' '}
                <Money value={loan.ledgerDocumentCharge} fallback="none" tone="plain" />
              </p>
              <p className="text-xs text-foreground">{loanReason(loan)}</p>
            </li>
          ))}
        </ul>
      )}
      {sorted.length > LOAN_PREVIEW ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="rounded-sm text-sm font-medium text-primary-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showAll ? 'Show fewer' : `Show all ${sorted.length} loans (${hidden} more)`}
        </button>
      ) : null}
    </section>
  );
}

function UnmatchedCharges({ tally }: { tally: AmountFlowTally }) {
  const list = tally.unmatchedDocumentCharges;
  if (!list.length) return null;
  return (
    <section aria-labelledby="tally-doc-title" className="space-y-2">
      <h3 id="tally-doc-title" className="text-sm font-semibold text-foreground">Document charge entries not matched to a loan ({list.length})</h3>
      <ul className="divide-y rounded-lg border">
        {list.map((c) => (
          <li key={c.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{c.note || 'Document charge'}</p>
              <p className="text-xs text-muted-foreground">
                <DateText value={c.date} /> · entry #{c.id}
              </p>
            </div>
            <Money value={c.amount} tone="plain" className="shrink-0 font-medium" />
          </li>
        ))}
      </ul>
    </section>
  );
}
