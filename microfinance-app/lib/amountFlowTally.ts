/**
 * Amount flow tally: checks the cash identity
 *
 *   Invested (net) + Cash inflow  =  Cash outflow + Total balance
 *
 * by putting the business records (contributions, repayments, auction payouts, loans) next
 * to the cash ledger (Transaction rows), category by category. Pure: the dashboard route
 * runs the queries and passes the sums in, so this can be unit-tested without a database.
 *
 * Business rule: a loan's document charge is kept back from the loan. The borrower gets
 * `amount − documentCharge` in hand and never pays the charge separately, so the cash given
 * is `amount − documentCharge` and a withheld document charge is not a cash inflow.
 *
 * Each row's `difference` is its effect on the balance: (ledger − records) for money in,
 * (records − ledger) for money out. The rows' differences therefore add up to
 * `ledgerComputedBalance − recordsExpectedBalance`; positive means the ledger holds more
 * cash than the records explain.
 */
import { loanCashGiven } from './centralizedFinancialCalculations';

export type TallyDirection = 'in' | 'out';

export interface TallyRow {
  key: string;
  label: string;
  direction: TallyDirection;
  records: number;
  ledger: number;
  difference: number;
}

export interface TallyLoanInput {
  id: number;
  borrower: string;
  amount: number;
  documentCharge: number;
  /** Disbursement transaction date (for matching its document-charge entry); null without one. */
  disbursementTransactionDate: Date | string | null;
  /** Amount of the loan's linked disbursement transaction; null when it has none. */
  ledgerDisbursed: number | null;
}

export interface TallyDocumentChargeInput {
  id: number;
  amount: number;
  date: Date | string;
  note: string | null;
}

export interface TallyLoanDetail {
  id: number;
  borrower: string;
  amount: number;
  documentCharge: number;
  /** amount − documentCharge: the cash the borrower got. */
  cashGiven: number;
  ledgerDisbursed: number | null;
  /** The DOCUMENT_CHARGE ledger entry matched to this loan, if any. */
  ledgerDocumentCharge: number | null;
  documentChargeTransactionId: number | null;
  /** This loan's effect on the balance difference: cashGiven − ledgerDisbursed + ledgerDocumentCharge. */
  difference: number;
}

export interface TallyUnmatchedDocumentCharge {
  id: number;
  amount: number;
  date: string;
  note: string | null;
}

export interface AmountFlowTallyInput {
  /** Net RECORD_AMOUNT (credits to a partner − debits from a partner). */
  investedNet: number;
  records: {
    contributions: number;
    repayments: number;
    auctionPayouts: number;
    /** Σ (loan.amount − documentCharge). */
    loanCashGiven: number;
  };
  /** Σ Transaction.amount per type (RECORD_AMOUNT excluded; it comes in as investedNet). */
  ledgerByType: Record<string, number>;
  /** The Total balance the dashboard's Partner-wise balance panel shows. */
  ledgerBalance: number;
  /** The running totalBalance stored on the latest transaction (null with no transactions). */
  runningBalance?: number | null;
  loans?: TallyLoanInput[];
  documentCharges?: TallyDocumentChargeInput[];
}

export interface AmountFlowTally {
  rows: TallyRow[];
  moneyIn: { records: number; ledger: number };
  moneyOut: { records: number; ledger: number };
  /** Σ in − Σ out over the records column. */
  recordsExpectedBalance: number;
  /** The panel's Total balance. */
  ledgerBalance: number;
  /** Σ in − Σ out over the ledger column; equals ledgerBalance when the ledger is consistent. */
  ledgerComputedBalance: number;
  /** ledgerBalance − recordsExpectedBalance. */
  difference: number;
  /** |difference| < 1. */
  tallied: boolean;
  /** ledgerComputedBalance − ledgerBalance (non-zero: entries the per-type sums and the panel see differently). */
  ledgerComputedDifference: number;
  /** Latest stored running totalBalance. */
  runningBalance: number | null;
  /** runningBalance − ledgerBalance; non-zero means the stored running balances are stale. */
  runningBalanceDifference: number | null;
  loanDetails: TallyLoanDetail[];
  unmatchedDocumentCharges: TallyUnmatchedDocumentCharge[];
}

/**
 * How each transaction type moves the total balance (same as lib/balanceCalculator.ts
 * calculateTransactionBalance). Transfers and unknown types do not move it.
 */
export const LEDGER_TYPE_EFFECT: Readonly<Record<string, 1 | -1 | 0>> = {
  CHIT_CONTRIBUTION: 1,
  LOAN_REPAYMENT: 1,
  loan_repaid: 1,
  DOCUMENT_CHARGE: 1,
  collection: 1,
  balance_adjustment: 1,
  AUCTION_PAYOUT: -1,
  LOAN_DISBURSEMENT: -1,
  loan_given: -1,
  expense: -1,
  transfer: 0,
  PARTNER_TO_PARTNER: 0,
};

/** Types with their own row; everything else that moves the balance is an "other" row. */
const CATEGORY_TYPES = new Set(['CHIT_CONTRIBUTION', 'LOAN_REPAYMENT', 'loan_repaid', 'AUCTION_PAYOUT', 'LOAN_DISBURSEMENT', 'loan_given', 'DOCUMENT_CHARGE', 'RECORD_AMOUNT']);

const OTHER_LABELS: Readonly<Record<string, string>> = {
  collection: 'Collections (manual entries)',
  expense: 'Expenses',
  balance_adjustment: 'Balance adjustments',
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

function row(key: string, label: string, direction: TallyDirection, records: number, ledger: number): TallyRow {
  const r = round2(records);
  const l = round2(ledger);
  return { key, label, direction, records: r, ledger: l, difference: round2(direction === 'in' ? l - r : r - l) };
}

/**
 * Pair each DOCUMENT_CHARGE entry with its loan. There is no foreign key: loan creation writes
 * the entry with the disbursement's date, the charge as amount and the note
 * "Document charge for loan to <borrower>" (the same match loan deletion uses).
 */
export function matchDocumentCharges(
  loans: TallyLoanInput[],
  charges: TallyDocumentChargeInput[]
): { byLoan: Map<number, TallyDocumentChargeInput>; unmatched: TallyDocumentChargeInput[] } {
  const byLoan = new Map<number, TallyDocumentChargeInput>();
  const used = new Set<number>();
  for (const loan of loans) {
    if (!(loan.documentCharge > 0) || !loan.disbursementTransactionDate) continue;
    const day = dayKey(loan.disbursementTransactionDate);
    const name = loan.borrower.trim().toLowerCase();
    const match = charges.find(
      (c) =>
        !used.has(c.id) &&
        Math.abs(c.amount - loan.documentCharge) < 0.005 &&
        dayKey(c.date) === day &&
        !!name &&
        (c.note ?? '').toLowerCase().includes(name)
    );
    if (match) {
      byLoan.set(loan.id, match);
      used.add(match.id);
    }
  }
  return { byLoan, unmatched: charges.filter((c) => !used.has(c.id)) };
}

export function computeAmountFlowTally(input: AmountFlowTallyInput): AmountFlowTally {
  const ledger = (type: string) => input.ledgerByType[type] ?? 0;

  const rows: TallyRow[] = [
    row('invested', 'Invested (net)', 'in', input.investedNet, input.investedNet),
    row('contributions', 'Chit contributions', 'in', input.records.contributions, ledger('CHIT_CONTRIBUTION')),
    row('repayments', 'Loan repayments', 'in', input.records.repayments, ledger('LOAN_REPAYMENT') + ledger('loan_repaid')),
    row('documentCharges', 'Document charges (kept back from loans)', 'in', 0, ledger('DOCUMENT_CHARGE')),
    row('auctionPayouts', 'Auction payouts', 'out', input.records.auctionPayouts, ledger('AUCTION_PAYOUT')),
    row('loanCashGiven', 'Cash given to borrowers', 'out', input.records.loanCashGiven, ledger('LOAN_DISBURSEMENT') + ledger('loan_given')),
  ];

  // Other entries that move the total balance (manual collections, expenses, adjustments).
  const otherTypes = Object.keys(input.ledgerByType)
    .filter((type) => !CATEGORY_TYPES.has(type) && (LEDGER_TYPE_EFFECT[type] ?? 0) !== 0 && ledger(type) !== 0)
    .sort();
  for (const type of otherTypes) {
    const direction: TallyDirection = LEDGER_TYPE_EFFECT[type] === 1 ? 'in' : 'out';
    rows.push(row(`other:${type}`, OTHER_LABELS[type] ?? `Other ledger entries (${type})`, direction, 0, ledger(type)));
  }

  const sum = (dir: TallyDirection, col: 'records' | 'ledger') =>
    round2(rows.filter((r) => r.direction === dir).reduce((s, r) => s + r[col], 0));
  const moneyIn = { records: sum('in', 'records'), ledger: sum('in', 'ledger') };
  const moneyOut = { records: sum('out', 'records'), ledger: sum('out', 'ledger') };

  const recordsExpectedBalance = round2(moneyIn.records - moneyOut.records);
  const ledgerComputedBalance = round2(moneyIn.ledger - moneyOut.ledger);
  const ledgerBalance = round2(input.ledgerBalance);
  const difference = round2(ledgerBalance - recordsExpectedBalance);
  const runningBalance = input.runningBalance === undefined || input.runningBalance === null ? null : round2(input.runningBalance);

  // Per-loan drill-down: loans whose ledger entries differ from the cash actually given.
  const loans = input.loans ?? [];
  const { byLoan, unmatched } = matchDocumentCharges(loans, input.documentCharges ?? []);
  const loanDetails: TallyLoanDetail[] = [];
  for (const loan of loans) {
    const cashGiven = round2(loanCashGiven(loan));
    const doc = byLoan.get(loan.id) ?? null;
    const ledgerDocumentCharge = doc ? round2(doc.amount) : null;
    const diff = round2(cashGiven - (loan.ledgerDisbursed ?? 0) + (ledgerDocumentCharge ?? 0));
    const disbursementMismatch = loan.ledgerDisbursed === null || Math.abs(loan.ledgerDisbursed - cashGiven) >= 0.005;
    if (!disbursementMismatch && !doc) continue;
    loanDetails.push({
      id: loan.id,
      borrower: loan.borrower,
      amount: round2(loan.amount),
      documentCharge: round2(loan.documentCharge || 0),
      cashGiven,
      ledgerDisbursed: loan.ledgerDisbursed === null ? null : round2(loan.ledgerDisbursed),
      ledgerDocumentCharge,
      documentChargeTransactionId: doc ? doc.id : null,
      difference: diff,
    });
  }

  return {
    rows,
    moneyIn,
    moneyOut,
    recordsExpectedBalance,
    ledgerBalance,
    ledgerComputedBalance,
    difference,
    tallied: Math.abs(difference) < 1,
    ledgerComputedDifference: round2(ledgerComputedBalance - ledgerBalance),
    runningBalance,
    runningBalanceDifference: runningBalance === null ? null : round2(runningBalance - ledgerBalance),
    loanDetails,
    unmatchedDocumentCharges: unmatched.map((c) => ({ id: c.id, amount: round2(c.amount), date: new Date(c.date).toISOString(), note: c.note })),
  };
}
