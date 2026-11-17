/**
 * Server loader for the tax report (GET /api/reports/itr): reads what buildItrReport needs for
 * one data owner, with narrow selects, plus the earliest record date (for the fiscal-year list)
 * and the number of Record Amount entries that still need a category.
 *
 * Owner scoping is the same as the dashboard and transactions routes: every row belongs to
 * `ownerId` (getCurrentUserId) through `createdById`, directly or through its loan / chit fund.
 * No money is calculated here; lib/itrReport.ts does that.
 */
import prisma from './prisma';
import type { ItrReportInput, ItrScope } from './itrReport';
import { categoryAllowsDirection, isRecordAmountCategory } from './recordAmountCategories';

export interface ItrReportDataOptions {
  scope: ItrScope;
  /** Rows on or after this instant cannot affect the period (the end, cut at the as-of day). */
  endExclusive: Date;
  /**
   * Chits / Loans scope have no opening balance, so ledger rows before the start are not
   * needed there. All scope reads every earlier row for the opening balance.
   */
  start: Date;
}

const LEDGER_SELECT = {
  id: true,
  type: true,
  amount: true,
  date: true,
  note: true,
  category: true,
  from_partner_id: true,
  to_partner_id: true,
} as const;

/** The rows buildItrReport reads for one period and scope. */
export async function loadItrReportInput(ownerId: number, { scope, start, endExclusive }: ItrReportDataOptions): Promise<ItrReportInput> {
  const withChits = scope !== 'loans';
  const withLoans = scope !== 'chits';
  const pooled = scope !== 'all';

  const [transactions, loans, chitFunds, partners] = await Promise.all([
    prisma.transaction.findMany({
      where: { createdById: ownerId, date: pooled ? { gte: start, lt: endExclusive } : { lt: endExclusive } },
      select: LEDGER_SELECT,
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }),
    withLoans
      ? prisma.loan.findMany({
          where: { createdById: ownerId },
          select: {
            id: true,
            amount: true,
            interestRate: true,
            interestPercentage: true,
            documentCharge: true,
            repaymentType: true,
            loanType: true,
            disbursementDate: true,
            status: true,
            nonRecoverableAt: true,
            recoveryPrincipalAtMark: true,
            remainingAmount: true,
            borrower: { select: { name: true } },
            // Interest is the difference of cumulative loan profit, so earlier repayments count;
            // later ones cannot change the period.
            repayments: {
              where: { paidDate: { lt: endExclusive } },
              select: { id: true, amount: true, paidDate: true, period: true, paymentType: true, principalComponent: true, interestComponent: true },
              orderBy: [{ paidDate: 'asc' }, { id: 'asc' }],
            },
          },
          orderBy: { id: 'asc' },
        })
      : Promise.resolve([]),
    withChits
      ? prisma.chitFund.findMany({
          where: { createdById: ownerId },
          select: {
            id: true,
            name: true,
            monthlyContribution: true,
            firstMonthContribution: true,
            duration: true,
            chitFundType: true,
            auctions: {
              where: { date: { gte: start, lt: endExclusive } },
              select: { id: true, amount: true, date: true, month: true, winner: { select: { globalMember: { select: { name: true } } } } },
              orderBy: [{ date: 'asc' }, { id: 'asc' }],
            },
          },
          orderBy: { id: 'asc' },
        })
      : Promise.resolve([]),
    // Active partners share the profit equally (ids ascending: the first takes any odd paisa).
    prisma.partner.findMany({
      where: { createdById: ownerId, isActive: true },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    }),
  ]);

  return { transactions, loans, chitFunds, partners };
}

/** Earliest dated record of the owner (ledger, loan disbursement, auction), or null with none. */
export async function loadEarliestRecordDate(ownerId: number): Promise<Date | null> {
  const [ledger, loan, auction] = await Promise.all([
    prisma.transaction.aggregate({ where: { createdById: ownerId }, _min: { date: true } }),
    prisma.loan.aggregate({ where: { createdById: ownerId }, _min: { disbursementDate: true } }),
    prisma.auction.aggregate({ where: { chitFund: { createdById: ownerId } }, _min: { date: true } }),
  ]);
  const times = [ledger._min.date, loan._min.disbursementDate, auction._min.date]
    .filter((d): d is Date => d instanceof Date)
    .map((d) => d.getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

/**
 * Record Amount entries, of any date, with no usable category: the same rule as
 * GET /api/transactions/classify (an entry with no partner moves no cash and is skipped).
 */
export async function countUnclassifiedEntries(ownerId: number): Promise<number> {
  const rows = await prisma.transaction.findMany({
    where: { createdById: ownerId, type: 'RECORD_AMOUNT' },
    select: { category: true, from_partner_id: true, to_partner_id: true },
  });
  return rows.filter((row) => {
    const direction = row.to_partner_id != null ? 'credit' : row.from_partner_id != null ? 'debit' : null;
    if (!direction) return false;
    return !(isRecordAmountCategory(row.category) && categoryAllowsDirection(row.category, direction));
  }).length;
}
