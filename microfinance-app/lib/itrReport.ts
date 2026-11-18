/**
 * ITR report: profit & loss, cash flow and partner share for one fiscal period, with the
 * records behind every line (for drill-down and the Excel export). Pure: the server loader
 * reads the rows and passes them in, so this is unit-tested without a database.
 *
 * Every amount is summed in whole paise and converted back at the edges, so month columns
 * add up to the period exactly and Q1 + Q2 = H1, H1 + H2 = FY hold to the paisa.
 * Dates are bucketed by IST calendar date (lib/fiscalPeriods.ts).
 */
import { calculateChitPayoutCommission, getChitTermContribution } from './chitCommission';
import { calculateLoanProfit } from './financialUtils';
import { LEDGER_TYPE_EFFECT } from './amountFlowTally';
import { NON_RECOVERABLE, roundMoney } from './loanRecovery';
import { RECORD_AMOUNT_CATEGORIES, categoryAllowsDirection, isRecordAmountCategory } from './recordAmountCategories';
import type { RecordAmountCategory, RecordAmountDirection } from './recordAmountCategories';
import {
  clampRangeToAsOf, filingYearLabel, fiscalPeriodLabel, fiscalPeriodRange, fiscalPeriodStatus,
  fiscalYearLabel, istDayKey, istDayStart, istNextDayStart, monthBuckets,
} from './fiscalPeriods';
import type { FiscalPeriodKey, FiscalPeriodStatus } from './fiscalPeriods';

export type ItrScope = 'all' | 'chits' | 'loans';
export const ITR_SCOPES: readonly ItrScope[] = ['all', 'chits', 'loans'];

type DateInput = Date | string;

// ---------------------------------------------------------------------------
// Input: Prisma rows, almost unchanged
// ---------------------------------------------------------------------------

export interface ItrLedgerRow {
  id: number;
  type: string;
  amount: number;
  date: DateInput;
  note?: string | null;
  /** RECORD_AMOUNT category (lib/recordAmountCategories.ts); ignored on other types. */
  category?: string | null;
  from_partner_id?: number | null;
  to_partner_id?: number | null;
}

export interface ItrRepaymentRow {
  id: number;
  amount: number;
  paidDate: DateInput;
  period: number;
  paymentType: string;
  principalComponent?: number | null;
  interestComponent?: number | null;
}

export interface ItrLoanRow {
  id: number;
  amount: number;
  interestRate: number;
  interestPercentage?: number | null;
  documentCharge?: number | null;
  repaymentType: string;
  loanType: string;
  disbursementDate: DateInput;
  status: string;
  nonRecoverableAt?: DateInput | null;
  recoveryPrincipalAtMark?: number | null;
  remainingAmount: number;
  borrower?: { name: string } | null;
  repayments: ItrRepaymentRow[];
}

export interface ItrAuctionRow {
  id: number;
  amount: number;
  date: DateInput;
  month: number;
  winner?: { globalMember?: { name: string } | null } | null;
}

export interface ItrChitFundRow {
  id: number;
  name: string;
  monthlyContribution: number;
  firstMonthContribution?: number | null;
  duration: number;
  chitFundType?: string;
  auctions: ItrAuctionRow[];
}

export interface ItrPartnerRow {
  id: number;
  name: string;
}

export interface ItrReportInput {
  transactions: ItrLedgerRow[];
  loans: ItrLoanRow[];
  chitFunds: ItrChitFundRow[];
  partners: ItrPartnerRow[];
}

export interface ItrReportOptions {
  /** Fiscal year start year (2025 = FY 2025-26). */
  fy: number;
  period: FiscalPeriodKey;
  scope: ItrScope;
  /** "Today"; a running period is cut at the start of the IST day after it. Default now. */
  asOf?: Date;
}

// ---------------------------------------------------------------------------
// Output: JSON-serialisable (dates as ISO strings, amounts in rupees to 2 decimals)
// ---------------------------------------------------------------------------

export type ItrLoanType = 'monthly' | 'weekly' | 'reducingBalance';
export type ItrRecordKind = 'chitPayout' | 'loanInterest' | 'documentCharge' | 'badDebtWrittenOff' | 'badDebtRecovered' | 'ledger';

export interface ItrRecord {
  kind: ItrRecordKind;
  /** Auction, loan, repayment or transaction id, by kind. */
  id: number;
  date: string | null;
  description: string;
  amount: number;
  // chitPayout
  fundId?: number;
  fundName?: string;
  member?: string | null;
  month?: number;
  termContribution?: number;
  payout?: number;
  // loan kinds
  loanId?: number;
  borrower?: string | null;
  loanType?: ItrLoanType | null;
  /** loanInterest: repayments dated in the period. */
  repaymentCount?: number;
  /** badDebtWrittenOff: principal still outstanding on the loan now. */
  outstanding?: number;
  // ledger
  type?: string;
  category?: RecordAmountCategory | null;
  note?: string | null;
  /** The partner whose cash moved; for a partner transfer, the sender. */
  partnerId?: number | null;
  /** Partner transfer only: the receiving partner. */
  toPartnerId?: number | null;
}

export interface ItrSeries {
  total: number;
  /** One amount per month bucket, in the same order. */
  months: number[];
}

export interface ItrLine extends ItrSeries {
  key: string;
  label: string;
  records: ItrRecord[];
}

export interface ItrProfitAndLoss {
  income: ItrLine[];
  /** Positive amounts; netProfit = totalIncome − totalExpenses. */
  expenses: ItrLine[];
  totalIncome: ItrSeries;
  totalExpenses: ItrSeries;
  netProfit: ItrSeries;
}

export interface ItrPartnerCash {
  /** null for "Unassigned": entries that move the total with no partner on that side. */
  partnerId: number | null;
  name: string;
  opening: number;
  in: number;
  out: number;
  transfersIn: number;
  transfersOut: number;
  closing: number;
}

export interface ItrCashFlow {
  /** Chits / Loans scope: cash is pooled, so no opening, closing, transfers or partner rows. */
  pooled: boolean;
  opening: number | null;
  closing: number | null;
  receipts: ItrLine[];
  /** Positive amounts; netMovement = totalReceipts − totalPayments. */
  payments: ItrLine[];
  totalReceipts: ItrSeries;
  totalPayments: ItrSeries;
  netMovement: ItrSeries;
  /** Cash at the end of each month bucket (null when pooled). */
  closingByMonth: number[] | null;
  /** Memo: total moved between partners. Its effect on the total is zero. */
  transfers: ItrLine | null;
  partners: ItrPartnerCash[];
}

export interface ItrPartnerShare {
  netProfit: number;
  /** Equal shares; the rounding remainder (in paise) goes to the first partner. */
  partners: { partnerId: number; name: string; share: number }[];
}

export type ItrWarningCode =
  | 'UNCLASSIFIED_ENTRIES'
  | 'NEGATIVE_OPENING_CASH'
  | 'NEGATIVE_CLOSING_CASH'
  | 'PERIOD_RUNNING';

export interface ItrWarning {
  code: ItrWarningCode;
  message: string;
  count?: number;
  amount?: number;
  records?: ItrRecord[];
}

export interface ItrReport {
  period: {
    fy: number;
    period: FiscalPeriodKey;
    scope: ItrScope;
    fiscalYearLabel: string;
    label: string;
    filingYearLabel: string;
    start: string;
    /** Cut at the as-of day for a running period. */
    endExclusive: string;
    /** The period's natural end. */
    fullEndExclusive: string;
    status: FiscalPeriodStatus;
    /** IST date (YYYY-MM-DD) the figures run to, when the period is running; else null. */
    asOf: string | null;
  };
  months: { key: string; label: string; start: string; endExclusive: string }[];
  profitAndLoss: ItrProfitAndLoss;
  cashFlow: ItrCashFlow;
  /** Only for scope `all`. */
  partnerShare: ItrPartnerShare | null;
  /** false for Chits / Loans: shared expenses and other income are not allocated to them. */
  sharedItemsAllocated: boolean;
  notes: string[];
  warnings: ItrWarning[];
}

// ---------------------------------------------------------------------------

const toPaise = (rupees: number | null | undefined) => Math.round(roundMoney(rupees || 0) * 100);
const fromPaise = (paise: number) => paise / 100;
const time = (date: DateInput | null | undefined) => (date == null ? NaN : new Date(date).getTime());
const iso = (date: DateInput) => new Date(date).toISOString();

interface LineAcc {
  key: string;
  label: string;
  /** Paise per month bucket. */
  months: number[];
  records: ItrRecord[];
}

const newLine = (key: string, label: string, monthCount: number): LineAcc =>
  ({ key, label, months: new Array(monthCount).fill(0), records: [] });

const sumPaise = (values: number[]) => values.reduce((sum, p) => sum + p, 0);
const series = (months: number[]): ItrSeries => ({ total: fromPaise(sumPaise(months)), months: months.map(fromPaise) });
const addMonths = (lines: LineAcc[], monthCount: number) =>
  Array.from({ length: monthCount }, (_, i) => sumPaise(lines.map((l) => l.months[i])));

function byDateThenId(a: ItrRecord, b: ItrRecord): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : 1;
  }
  return a.id - b.id;
}

const finishLine = (line: LineAcc): ItrLine =>
  ({ key: line.key, label: line.label, ...series(line.months), records: [...line.records].sort(byDateThenId) });

/** Which calculateLoanProfit branch a loan takes (same tests, same order); null = no interest rule. */
function loanInterestType(loan: Pick<ItrLoanRow, 'repaymentType' | 'loanType'>): ItrLoanType | null {
  if (loan.repaymentType === 'Monthly' && loan.loanType !== 'Reducing Balance') return 'monthly';
  if (loan.repaymentType === 'Weekly') return 'weekly';
  if (loan.loanType === 'Reducing Balance' || loan.repaymentType === 'Reducing Balance') return 'reducingBalance';
  return null;
}

const LOAN_INTEREST_LINES: { type: ItrLoanType; label: string }[] = [
  { type: 'monthly', label: 'Loan interest (Monthly)' },
  { type: 'weekly', label: 'Loan interest (Weekly)' },
  { type: 'reducingBalance', label: 'Loan interest (Reducing Balance)' },
];

const TRANSFER_TYPES = new Set(['transfer', 'PARTNER_TO_PARTNER']);

/** Ledger types with their own cash line; other types that move the total get an `other:<type>` line. */
const TYPE_LINE: Readonly<Record<string, string>> = {
  CHIT_CONTRIBUTION: 'chitContributions',
  LOAN_REPAYMENT: 'loanRepayments',
  loan_repaid: 'loanRepayments',
  DOCUMENT_CHARGE: 'documentCharges',
  AUCTION_PAYOUT: 'auctionPayouts',
  LOAN_DISBURSEMENT: 'loanDisbursements',
  loan_given: 'loanDisbursements',
};

const OTHER_TYPE_LABELS: Readonly<Record<string, string>> = {
  collection: 'Collections (older entries)',
  expense: 'Expenses (older entries)',
  balance_adjustment: 'Balance adjustments (older entries)',
};

interface CashLineSpec {
  key: string;
  label: string;
  side: 'in' | 'out';
  scopes: readonly ItrScope[];
}

const recordLineKey = (category: RecordAmountCategory | null, direction: RecordAmountDirection) =>
  `record:${category ?? 'UNCLASSIFIED'}:${direction === 'credit' ? 'in' : 'out'}`;

function recordLines(direction: RecordAmountDirection): CashLineSpec[] {
  const side = direction === 'credit' ? 'in' : 'out';
  return [
    ...RECORD_AMOUNT_CATEGORIES.filter((c) => c.directions.includes(direction))
      .map((c) => ({ key: recordLineKey(c.value, direction), label: c.cashFlowLabel, side, scopes: ['all'] } as CashLineSpec)),
    { key: recordLineKey(null, direction), label: `Unclassified (${direction})`, side, scopes: ['all'] },
  ];
}

/**
 * Loans are in the ledger gross: a LOAN_DISBURSEMENT of the full loan amount (a payment) and a
 * DOCUMENT_CHARGE of the charge kept back from it (a receipt), which together net to the cash the
 * borrower got. The P&L takes the document-charge income from the loan records, not from these
 * ledger entries, so it is not counted twice.
 */
const CASH_LINES: CashLineSpec[] = [
  { key: 'chitContributions', label: 'Chit contributions', side: 'in', scopes: ['all', 'chits'] },
  { key: 'loanRepayments', label: 'Loan repayments', side: 'in', scopes: ['all', 'loans'] },
  { key: 'documentCharges', label: 'Document charges (kept back from loans)', side: 'in', scopes: ['all', 'loans'] },
  ...recordLines('credit'),
  { key: 'auctionPayouts', label: 'Auction payouts', side: 'out', scopes: ['all', 'chits'] },
  { key: 'loanDisbursements', label: 'Loans disbursed (full amount)', side: 'out', scopes: ['all', 'loans'] },
  ...recordLines('debit'),
];

const typeEffect = (type: string): number =>
  (Object.prototype.hasOwnProperty.call(LEDGER_TYPE_EFFECT, type) ? LEDGER_TYPE_EFFECT[type] : 0);

type LedgerMove =
  | { kind: 'cash'; lineKey: string; delta: number; partnerId: number | null; category: RecordAmountCategory | null; manual: boolean }
  | { kind: 'transfer'; amount: number; from: number | null; to: number | null };

/**
 * How one ledger row moves cash, following calculateTransactionBalance: money in is credited to
 * to_partner_id, money out is debited from from_partner_id, transfers move between partners and
 * leave the total unchanged, unknown types do nothing. RECORD_AMOUNT is a credit when
 * to_partner_id is set, else a debit when from_partner_id is set (replayBalances takes
 * to_partner_id first). A category that does not allow the row's direction counts as unclassified.
 */
function classifyLedgerRow(row: ItrLedgerRow): LedgerMove | null {
  const amount = toPaise(row.amount);
  const from = row.from_partner_id ?? null;
  const to = row.to_partner_id ?? null;
  if (TRANSFER_TYPES.has(row.type)) return { kind: 'transfer', amount, from, to };
  if (row.type === 'RECORD_AMOUNT') {
    const direction: RecordAmountDirection | null = to != null ? 'credit' : from != null ? 'debit' : null;
    if (!direction) return null;
    const category = isRecordAmountCategory(row.category) && categoryAllowsDirection(row.category, direction) ? row.category : null;
    return {
      kind: 'cash', lineKey: recordLineKey(category, direction), category, manual: true,
      delta: direction === 'credit' ? amount : -amount, partnerId: direction === 'credit' ? to : from,
    };
  }
  const effect = typeEffect(row.type);
  if (effect === 0) return null;
  return {
    kind: 'cash', lineKey: TYPE_LINE[row.type] ?? `other:${row.type}`, category: null, manual: false,
    delta: effect * amount, partnerId: effect > 0 ? to : from,
  };
}

interface PartnerAcc {
  partnerId: number | null;
  name: string;
  opening: number;
  in: number;
  out: number;
  transfersIn: number;
  transfersOut: number;
}

export function buildItrReport(input: ItrReportInput, options: ItrReportOptions): ItrReport {
  const { fy, period, scope } = options;
  const asOf = options.asOf ?? new Date();
  const fullRange = fiscalPeriodRange(fy, period);
  const status = fiscalPeriodStatus(fullRange, asOf);
  const range = clampRangeToAsOf(fullRange, asOf);
  const buckets = monthBuckets(range);
  const monthCount = buckets.length;
  const startMs = range.start.getTime();
  const endMs = range.endExclusive.getTime();
  // Rows on or after this instant are in the future and ignored, also for the opening balance.
  const cutoffMs = istNextDayStart(asOf).getTime();
  const bounds = [startMs, ...buckets.map((b) => b.endExclusive.getTime())];
  const monthOf = (date: DateInput | null | undefined): number => {
    const t = time(date);
    if (!(t >= startMs && t < endMs)) return -1;
    for (let i = 0; i < monthCount; i++) if (t < bounds[i + 1]) return i;
    return -1;
  };
  const withChits = scope !== 'loans';
  const withLoans = scope !== 'chits';
  const withShared = scope === 'all';

  // ---- Profit & loss ------------------------------------------------------

  const chitMargin = newLine('chitMargin', 'Chit margin', monthCount);
  const loanInterest = new Map<ItrLoanType, LineAcc>();
  const documentCharges = newLine('documentCharges', 'Document charges', monthCount);
  const otherIncome = newLine('otherIncome', 'Other income', monthCount);
  const badDebtRecovered = newLine('badDebtRecovered', 'Bad debt recovered', monthCount);
  const expenses = newLine('expenses', 'Expenses', monthCount);
  const badDebtWrittenOff = newLine('badDebtWrittenOff', 'Bad debts written off', monthCount);

  if (withChits) {
    // Counted by payout date only (not getCountedChitAuctions, which depends on today's fund month).
    for (const fund of input.chitFunds) {
      const termContribution = roundMoney(getChitTermContribution(fund));
      for (const auction of fund.auctions) {
        const i = monthOf(auction.date);
        if (i < 0) continue;
        const margin = toPaise(calculateChitPayoutCommission(fund, auction));
        const member = auction.winner?.globalMember?.name ?? null;
        chitMargin.months[i] += margin;
        chitMargin.records.push({
          kind: 'chitPayout', id: auction.id, date: iso(auction.date), amount: fromPaise(margin),
          description: `${fund.name} · month ${auction.month}${member ? ` · ${member}` : ''}`,
          fundId: fund.id, fundName: fund.name, member, month: auction.month, termContribution, payout: roundMoney(auction.amount),
        });
      }
    }
  }

  if (withLoans) {
    for (const type of LOAN_INTEREST_LINES) {
      if (input.loans.some((loan) => loanInterestType(loan) === type.type)) {
        loanInterest.set(type.type, newLine(`loanInterest:${type.type}`, type.label, monthCount));
      }
    }
    for (const loan of input.loans) {
      const borrower = loan.borrower?.name ?? null;
      const loanType = loanInterestType(loan);
      const name = `Loan #${loan.id}${borrower ? ` · ${borrower}` : ''}`;
      // A loan is still a recovery case only while its status is Non-Recoverable. Restoring
      // (lib/loanRecoveryService.ts, action 'restore') sets status back to Active and
      // recoveryOutcome 'Restored' but keeps nonRecoverableAt, so nonRecoverableAt alone is not
      // enough. Collecting and settling keep the status, so a recovered or settled case still
      // shows its write-off. A loan restored after the period ended drops out of that period too:
      // the report reads the loan's current state, not its history.
      const markMs = time(loan.nonRecoverableAt);
      const recoveryCase = loan.status === NON_RECOVERABLE && !Number.isNaN(markMs);
      const markDayMs = recoveryCase ? istDayStart(new Date(markMs)).getTime() : NaN;
      // RECOVERY receipts of the current case (dated on or after the IST day it was marked).
      // Receipts from an earlier, restored case are ordinary principal repayments.
      const inCase = (r: ItrRepaymentRow) => recoveryCase && r.paymentType === 'RECOVERY' && istDayStart(r.paidDate).getTime() >= markDayMs;

      if (loanType) {
        const line = loanInterest.get(loanType);
        // Recovered principal of the current case is reported once, as "Bad debt recovered".
        // calculateLoanProfit's Weekly branch lowers its principal threshold by recovered
        // principal, which would turn the same rupees into interest as well; zeroing the
        // principal here keeps them out of interest. Monthly ignores principalComponent, and a
        // Non-Recoverable Reducing Balance loan takes no ordinary repayments after the mark, so
        // only Weekly changes. Recovery interest (interestComponent) stays in loan interest.
        // Over the loan's life: interest on ordinary repayments + recovered − written off. Weekly
        // remainingAmount is period-based, so when installments exceed amount / (duration − 1)
        // the write-off is larger than the principal the Weekly rule still sees as unpaid, and
        // this report shows less for that loan than calculateLoanProfit on the dashboard.
        const repayments = loan.repayments.map((r) => ({
          amount: r.amount, paymentType: r.paymentType, paidDate: new Date(r.paidDate), period: r.period,
          principalComponent: inCase(r) ? 0 : r.principalComponent ?? null, interestComponent: r.interestComponent ?? null,
        }));
        const terms = {
          amount: loan.amount, interestRate: loan.interestRate, interestPercentage: loan.interestPercentage ?? null,
          documentCharge: loan.documentCharge ?? 0, repaymentType: loan.repaymentType, loanType: loan.loanType,
        };
        // Interest up to each bound; differencing cancels the document charge calculateLoanProfit adds.
        const profitBefore = (bound: number) => toPaise(calculateLoanProfit(terms, repayments.filter((r) => r.paidDate.getTime() < bound)));
        const cumulative = bounds.map(profitBefore);
        let total = 0;
        for (let i = 0; i < monthCount; i++) {
          const amount = cumulative[i + 1] - cumulative[i];
          line.months[i] += amount;
          total += amount;
        }
        const repaymentCount = loan.repayments.filter((r) => monthOf(r.paidDate) >= 0).length;
        if (total !== 0 || repaymentCount > 0) {
          line.records.push({
            kind: 'loanInterest', id: loan.id, date: null, description: name, amount: fromPaise(total),
            loanId: loan.id, borrower, loanType, repaymentCount,
          });
        }
      }

      const docMonth = monthOf(loan.disbursementDate);
      const charge = toPaise(loan.documentCharge);
      if (docMonth >= 0 && charge !== 0) {
        documentCharges.months[docMonth] += charge;
        documentCharges.records.push({
          kind: 'documentCharge', id: loan.id, date: iso(loan.disbursementDate), description: `Document charge · ${name}`,
          amount: fromPaise(charge), loanId: loan.id, borrower, loanType,
        });
      }

      const markMonth = recoveryCase ? monthOf(loan.nonRecoverableAt) : -1;
      const writtenOff = toPaise(loan.recoveryPrincipalAtMark);
      if (markMonth >= 0 && writtenOff !== 0) {
        badDebtWrittenOff.months[markMonth] += writtenOff;
        badDebtWrittenOff.records.push({
          kind: 'badDebtWrittenOff', id: loan.id, date: iso(loan.nonRecoverableAt), description: `${name} marked Non-Recoverable`,
          amount: fromPaise(writtenOff), loanId: loan.id, borrower, loanType, outstanding: roundMoney(loan.remainingAmount),
        });
      }

      for (const r of loan.repayments) {
        const i = inCase(r) ? monthOf(r.paidDate) : -1;
        const principal = toPaise(r.principalComponent);
        if (i < 0 || principal === 0) continue;
        badDebtRecovered.months[i] += principal;
        badDebtRecovered.records.push({
          kind: 'badDebtRecovered', id: r.id, date: iso(r.paidDate), description: `Recovery · ${name}`,
          amount: fromPaise(principal), loanId: loan.id, borrower, loanType,
        });
      }
    }
  }

  // ---- Cash flow (ledger) -------------------------------------------------

  const specs: CashLineSpec[] = CASH_LINES.filter((s) => s.scopes.includes(scope));
  if (withShared) {
    // Other types that move the total (older lower-case entries); listed when the input has any.
    const otherTypes = [...new Set(input.transactions.map((t) => t.type))]
      .filter((type) => !TYPE_LINE[type] && type !== 'RECORD_AMOUNT' && typeEffect(type) !== 0)
      .sort();
    for (const type of otherTypes) {
      specs.push({ key: `other:${type}`, label: OTHER_TYPE_LABELS[type] ?? `Other entries (${type})`, side: typeEffect(type) > 0 ? 'in' : 'out', scopes: ['all'] });
    }
  }
  const cashLines = new Map<string, { line: LineAcc; side: 'in' | 'out' }>();
  for (const spec of specs) cashLines.set(spec.key, { line: newLine(spec.key, spec.label, monthCount), side: spec.side });
  const transfers = newLine('partnerTransfers', 'Partner transfers (memo, net zero)', monthCount);

  const partnerAccs = new Map<number | null, PartnerAcc>();
  const partnerAcc = (id: number | null): PartnerAcc => {
    let acc = partnerAccs.get(id);
    if (!acc) {
      acc = { partnerId: id, name: id === null ? 'Unassigned' : `Partner #${id}`, opening: 0, in: 0, out: 0, transfersIn: 0, transfersOut: 0 };
      partnerAccs.set(id, acc);
    }
    return acc;
  };
  for (const p of input.partners) partnerAcc(p.id).name = p.name;

  // A transfer's debit row is written right before its credit row (same type, date and amount),
  // so the memo record of the debit row can name the receiving partner.
  const transferReceiver = new Map<number, number>();
  const byId = new Map(input.transactions.map((t) => [t.id, t]));
  for (const row of input.transactions) {
    const next = TRANSFER_TYPES.has(row.type) && row.from_partner_id != null && row.to_partner_id == null ? byId.get(row.id + 1) : undefined;
    if (next && next.type === row.type && next.from_partner_id == null && next.to_partner_id != null
      && toPaise(next.amount) === toPaise(row.amount) && time(next.date) === time(row.date)) {
      transferReceiver.set(row.id, next.to_partner_id);
    }
  }

  let opening = 0;
  const unclassified: ItrRecord[] = [];

  for (const row of input.transactions) {
    const t = time(row.date);
    if (!(t < cutoffMs)) continue;
    const move = classifyLedgerRow(row);
    if (!move) continue;
    if (move.kind === 'transfer' ? !withShared : !cashLines.has(move.lineKey)) continue;

    if (t < startMs) {
      // Pooled scopes have no opening balance.
      if (!withShared) continue;
      if (move.kind === 'transfer') {
        partnerAcc(move.from).opening -= move.amount;
        partnerAcc(move.to).opening += move.amount;
      } else {
        opening += move.delta;
        partnerAcc(move.partnerId).opening += move.delta;
      }
      continue;
    }
    const i = monthOf(row.date);
    if (i < 0) continue;
    const base: ItrRecord = {
      kind: 'ledger', id: row.id, date: iso(row.date), description: row.note?.trim() || row.type, amount: 0,
      type: row.type, note: row.note ?? null,
    };

    if (move.kind === 'transfer') {
      // POST /api/transactions stores a transfer as a debit row (from only) and a credit row
      // (to only); older rows carry both partners. The memo counts each transfer once, on its
      // sending row. Partner balances take both rows; the halves' Unassigned sides net out below.
      if (move.from !== null) {
        transfers.months[i] += move.amount;
        const toPartnerId = move.to ?? transferReceiver.get(row.id) ?? null;
        transfers.records.push({ ...base, amount: fromPaise(move.amount), partnerId: move.from, toPartnerId });
      }
      partnerAcc(move.from).transfersOut += move.amount;
      partnerAcc(move.to).transfersIn += move.amount;
      continue;
    }

    const { line, side } = cashLines.get(move.lineKey);
    const lineAmount = side === 'in' ? move.delta : -move.delta;
    const record: ItrRecord = { ...base, amount: fromPaise(lineAmount), ...(move.manual ? { category: move.category } : {}), partnerId: move.partnerId };
    line.months[i] += lineAmount;
    line.records.push(record);
    if (withShared) {
      const acc = partnerAcc(move.partnerId);
      if (move.delta >= 0) acc.in += move.delta;
      else acc.out -= move.delta;
    }

    if (move.manual && move.category === 'EXPENSE') {
      expenses.months[i] -= move.delta;
      expenses.records.push({ ...record, amount: fromPaise(-move.delta) });
    } else if (move.manual && move.category === 'OTHER_INCOME') {
      otherIncome.months[i] += move.delta;
      otherIncome.records.push(record);
    } else if (move.manual && move.category === null) {
      unclassified.push(record);
    }
  }

  // ---- Assemble -----------------------------------------------------------

  const incomeLines: LineAcc[] = [
    ...(withChits ? [chitMargin] : []),
    ...(withLoans ? [...loanInterest.values(), documentCharges] : []),
    ...(withShared ? [otherIncome] : []),
    ...(withLoans ? [badDebtRecovered] : []),
  ];
  const expenseLines: LineAcc[] = [
    ...(withShared ? [expenses] : []),
    ...(withLoans ? [badDebtWrittenOff] : []),
  ];
  const incomeMonths = addMonths(incomeLines, monthCount);
  const expenseMonths = addMonths(expenseLines, monthCount);
  const netProfitMonths = incomeMonths.map((p, i) => p - expenseMonths[i]);
  const netProfitPaise = sumPaise(netProfitMonths);

  const receiptAccs = [...cashLines.values()].filter((c) => c.side === 'in').map((c) => c.line);
  const paymentAccs = [...cashLines.values()].filter((c) => c.side === 'out').map((c) => c.line);
  const receiptMonths = addMonths(receiptAccs, monthCount);
  const paymentMonths = addMonths(paymentAccs, monthCount);
  const netMonths = receiptMonths.map((p, i) => p - paymentMonths[i]);
  const closing = opening + sumPaise(netMonths);
  let running = opening;
  const closingByMonth = netMonths.map((p) => fromPaise((running += p)));

  // The two rows of a transfer each leave one side to Unassigned; only the unmatched remainder
  // (a transfer row whose other half is missing) is Unassigned's.
  const unassigned = partnerAccs.get(null);
  if (unassigned) {
    const net = unassigned.transfersIn - unassigned.transfersOut;
    unassigned.transfersIn = Math.max(net, 0);
    unassigned.transfersOut = Math.max(-net, 0);
  }

  const partners: ItrPartnerCash[] = withShared
    ? [...partnerAccs.values()]
      .filter((acc) => input.partners.some((p) => p.id === acc.partnerId) || acc.opening || acc.in || acc.out || acc.transfersIn || acc.transfersOut)
      .sort((a, b) => (a.partnerId === null ? 1 : b.partnerId === null ? -1 : 0))
      .map((acc) => ({
        partnerId: acc.partnerId, name: acc.name, opening: fromPaise(acc.opening), in: fromPaise(acc.in), out: fromPaise(acc.out),
        transfersIn: fromPaise(acc.transfersIn), transfersOut: fromPaise(acc.transfersOut),
        closing: fromPaise(acc.opening + acc.in - acc.out + acc.transfersIn - acc.transfersOut),
      }))
    : [];

  let partnerShare: ItrPartnerShare | null = null;
  if (withShared) {
    const count = input.partners.length;
    const each = count ? Math.trunc(netProfitPaise / count) : 0;
    const remainder = netProfitPaise - each * count;
    partnerShare = {
      netProfit: fromPaise(netProfitPaise),
      partners: input.partners.map((p, i) => ({ partnerId: p.id, name: p.name, share: fromPaise(each + (i === 0 ? remainder : 0)) })),
    };
  }

  const warnings: ItrWarning[] = [];
  if (unclassified.length) {
    warnings.push({
      code: 'UNCLASSIFIED_ENTRIES', count: unclassified.length,
      amount: fromPaise(sumPaise(unclassified.map((r) => toPaise(r.amount)))), records: [...unclassified].sort(byDateThenId),
      message: `${unclassified.length} manual ${unclassified.length === 1 ? 'entry has' : 'entries have'} no category. They are kept out of the profit & loss until classified.`,
    });
  }
  if (withShared && opening < 0) {
    warnings.push({ code: 'NEGATIVE_OPENING_CASH', amount: fromPaise(opening), message: 'Opening cash is negative: more was paid out than recorded coming in before this period (funded outside the ledger).' });
  }
  if (withShared && closing < 0) {
    warnings.push({ code: 'NEGATIVE_CLOSING_CASH', amount: fromPaise(closing), message: 'Closing cash is negative: more was paid out than recorded coming in (funded outside the ledger).' });
  }
  const asOfKey = status === 'running' ? istDayKey(asOf) : null;
  if (asOfKey) {
    warnings.push({ code: 'PERIOD_RUNNING', message: `This period is still running. Figures are to date (${asOfKey}).` });
  }

  const notes = withShared ? [] : [
    `Shared expenses and other income are not allocated to ${scope === 'chits' ? 'Chits' : 'Loans'}; they appear under All.`,
    'Cash is pooled across the business, so this view shows receipts, payments and net movement only (no opening or closing balance, no partner cash).',
    'Partner share is given for All only.',
  ];

  return {
    period: {
      fy, period, scope,
      fiscalYearLabel: fiscalYearLabel(fy), label: fiscalPeriodLabel(fy, period), filingYearLabel: filingYearLabel(fy),
      start: range.start.toISOString(), endExclusive: range.endExclusive.toISOString(), fullEndExclusive: fullRange.endExclusive.toISOString(),
      status, asOf: asOfKey,
    },
    months: buckets.map((b) => ({ key: b.key, label: b.label, start: b.start.toISOString(), endExclusive: b.endExclusive.toISOString() })),
    profitAndLoss: {
      income: incomeLines.map(finishLine),
      expenses: expenseLines.map(finishLine),
      totalIncome: series(incomeMonths),
      totalExpenses: series(expenseMonths),
      netProfit: series(netProfitMonths),
    },
    cashFlow: {
      pooled: !withShared,
      opening: withShared ? fromPaise(opening) : null,
      closing: withShared ? fromPaise(closing) : null,
      receipts: receiptAccs.map(finishLine),
      payments: paymentAccs.map(finishLine),
      totalReceipts: series(receiptMonths),
      totalPayments: series(paymentMonths),
      netMovement: series(netMonths),
      closingByMonth: withShared ? closingByMonth : null,
      transfers: withShared ? finishLine(transfers) : null,
      partners,
    },
    partnerShare,
    sharedItemsAllocated: withShared,
    notes,
    warnings,
  };
}
