/**
 * Member 360 summary (GET /api/members/consolidated?action=summary): lifetime money moved in each
 * direction, the profit earned from the member, and one card per chit membership and per loan.
 *
 * Pure: the route loads the rows, this file only does arithmetic, so it can be unit tested.
 * Profit reuses the dashboard's formulas unchanged:
 *   - loans: calculateLoanProfit (lib/financialUtils.ts) per loan
 *   - chits: calculateChitPayoutCommission (lib/chitCommission.ts) per auction the member WON,
 *     counted only when month <= the fund's current month and date <= now, the same filter as
 *     calculateChitFundProfitUpToCurrentMonth, so a fund's winners add up to its totalProfit.
 * Cash flow counts every recorded row (contributions, repayments incl. RECOVERY receipts, loan
 * disbursements, auction payouts), the same rows the member timeline shows.
 */
import { calculateLoanProfit } from './financialUtils';
import { calculateChitPayoutCommission } from './chitCommission';

type DateLike = Date | string;

export interface SummaryFundInput {
  id: number;
  name: string;
  status: string;
  totalAmount: number;
  monthlyContribution: number;
  firstMonthContribution?: number | null;
  membersCount: number;
  chitFundType?: string | null;
  currentMonth?: number | null;
  startDate?: DateLike | null;
  duration?: number | null;
}

export interface SummaryMembershipInput {
  id: number;
  joinDate: DateLike;
  chitFund: SummaryFundInput;
  contributions: { amount: number; month: number; paidDate: DateLike }[];
  /** Auctions this membership (Member row) won: Auction.winnerId = Member.id. */
  auctions: { id: number; month: number; date: DateLike; amount: number }[];
}

export interface SummaryRepaymentInput {
  amount: number;
  paymentType: string;
  paidDate: DateLike;
  period: number;
  principalComponent?: number | null;
  interestComponent?: number | null;
}

export interface SummaryLoanInput {
  id: number;
  loanType: string;
  repaymentType: string;
  status: string;
  disbursementDate: DateLike;
  amount: number;
  interestRate: number;
  interestPercentage?: number | null;
  documentCharge?: number | null;
  remainingAmount: number;
  nonRecoverableAt?: DateLike | null;
  nonRecoverableReason?: string | null;
  recoveryPrincipalAtMark?: number | null;
  recoveryDuesAtMark?: number | null;
  recoveryInterestOutstanding?: number | null;
  recoveryAmount?: number | null;
  recoveryOutcome?: string | null;
  repayments: SummaryRepaymentInput[];
}

export interface MemberSummaryTotals {
  /** contributionsPaid + repaymentsReceived */
  moneyIn: number;
  /** loanPrincipalOut − documentCharges + auctionPayoutsOut (cash actually handed to the member) */
  moneyOut: number;
  /** moneyIn − moneyOut; positive = the member has paid in more than received */
  netCashFlow: number;
  /** loanProfit + chitCommission */
  profit: number;
  loanProfit: number;
  chitCommission: number;
  contributionsPaid: number;
  repaymentsReceived: number;
  /** Σ Loan.amount (principal lent, before the document charge is withheld) */
  loanPrincipalOut: number;
  auctionPayoutsOut: number;
  /** Σ Loan.documentCharge, withheld from the cash handed over at disbursement */
  documentCharges: number;
}

export interface MemberSummaryChitWin {
  auctionId: number;
  month: number;
  date: string;
  /** Auction.amount, the cash paid to the winner */
  payout: number;
  /** fund.totalAmount − payout */
  discount: number;
  /** discount as % of fund.totalAmount, 2 decimals (0 when totalAmount is 0) */
  discountPct: number;
  /** calculateChitPayoutCommission; 0 when the auction is not counted yet */
  commission: number;
  /** false for an auction after the fund's current month or dated in the future (no commission yet) */
  counted: boolean;
}

export interface MemberSummaryChit {
  membershipId: number;
  fundId: number;
  name: string;
  status: string;
  joinDate: string;
  monthlyContribution: number;
  contributionsPaid: number;
  /** distinct months with at least one contribution row */
  monthsPaid: number;
  duration: number | null;
  /** earliest auction this membership won, or null if it has not won yet */
  won: MemberSummaryChitWin | null;
  /** commission credited from this membership's counted wins (normally the single `won`) */
  commission: number;
}

export interface MemberSummaryLoanRecovery {
  markedAt: string | null;
  reason: string | null;
  principalAtMark: number | null;
  duesAtMark: number | null;
  interestOutstanding: number;
  recovered: number;
  outcome: string | null;
}

export interface MemberSummaryLoan {
  id: number;
  loanType: string;
  repaymentType: string;
  status: string;
  disbursementDate: string;
  principal: number;
  documentCharge: number;
  /** principal − documentCharge, the cash handed over */
  cashDisbursed: number;
  /** every repayment incl. RECOVERY receipts */
  totalRepaid: number;
  profit: number;
  remainingAmount: number;
  installmentsPaid: number;
  lastRepaymentDate: string | null;
  /** set for loans that were ever marked Non-Recoverable */
  recovery: MemberSummaryLoanRecovery | null;
}

export interface MemberSummary {
  memberId: number;
  asOf: string;
  totals: MemberSummaryTotals;
  keyDates: {
    memberSince: string;
    /** earliest of chit join dates, contributions, auction wins, loan disbursements and repayments */
    firstActivity: string | null;
    /** latest contribution or repayment paid date */
    lastPayment: string | null;
  };
  chits: MemberSummaryChit[];
  loans: MemberSummaryLoan[];
}

const round2 = (n: number) => Math.round((n || 0) * 100) / 100;
const iso = (d: DateLike) => new Date(d).toISOString();
const time = (d: DateLike) => new Date(d).getTime();

/**
 * The fund's current month exactly as calculateChitFundProfitUpToCurrentMonth derives it
 * (lib/financialUtils.ts), with `now` as the clock.
 */
export function fundCurrentMonth(fund: SummaryFundInput, now: Date): number {
  let currentMonth = fund.currentMonth || 1;
  if (!fund.currentMonth && fund.startDate) {
    const start = new Date(fund.startDate);
    if (start <= now) {
      const diffYears = now.getFullYear() - start.getFullYear();
      const diffMonths = now.getMonth() - start.getMonth();
      let monthDiff = diffYears * 12 + diffMonths + 1;
      if (now.getDate() < start.getDate()) monthDiff--;
      currentMonth = Math.min(Math.max(1, monthDiff), fund.duration || 1);
    }
  }
  return currentMonth;
}

/** Same auction filter as calculateChitFundProfitUpToCurrentMonth. */
export function isCountedAuction(auction: { month?: number; date?: DateLike }, currentMonth: number, now: Date): boolean {
  return (!auction.month || auction.month <= currentMonth) && (!auction.date || new Date(auction.date) <= now);
}

const INTEREST_ONLY = ['interestOnly', 'INTEREST_ONLY'];

export function buildMemberSummary(
  member: { id: number; createdAt: DateLike },
  memberships: SummaryMembershipInput[],
  loans: SummaryLoanInput[],
  now: Date = new Date(),
): MemberSummary {
  const activity: number[] = [];
  const payments: number[] = [];
  let contributionsPaid = 0;
  let auctionPayoutsOut = 0;
  let chitCommission = 0;

  const chits: MemberSummaryChit[] = memberships.map((m) => {
    const fund = m.chitFund;
    const currentMonth = fundCurrentMonth(fund, now);
    const paid = m.contributions.reduce((sum, c) => sum + (c.amount || 0), 0);
    contributionsPaid += paid;
    activity.push(time(m.joinDate));
    for (const c of m.contributions) { activity.push(time(c.paidDate)); payments.push(time(c.paidDate)); }

    let commission = 0;
    for (const a of m.auctions) {
      auctionPayoutsOut += a.amount || 0;
      activity.push(time(a.date));
      if (isCountedAuction(a, currentMonth, now)) commission += calculateChitPayoutCommission(fund, a);
    }
    chitCommission += commission;

    const first = [...m.auctions].sort((a, b) => a.month - b.month || time(a.date) - time(b.date))[0];
    let won: MemberSummaryChitWin | null = null;
    if (first) {
      const counted = isCountedAuction(first, currentMonth, now);
      const discount = (fund.totalAmount || 0) - (first.amount || 0);
      won = {
        auctionId: first.id,
        month: first.month,
        date: iso(first.date),
        payout: round2(first.amount),
        discount: round2(discount),
        discountPct: fund.totalAmount ? round2((discount / fund.totalAmount) * 100) : 0,
        commission: counted ? round2(calculateChitPayoutCommission(fund, first)) : 0,
        counted,
      };
    }

    return {
      membershipId: m.id,
      fundId: fund.id,
      name: fund.name,
      status: fund.status,
      joinDate: iso(m.joinDate),
      monthlyContribution: round2(fund.monthlyContribution),
      contributionsPaid: round2(paid),
      monthsPaid: new Set(m.contributions.map((c) => c.month)).size,
      duration: fund.duration ?? null,
      won,
      commission: round2(commission),
    };
  });

  let loanPrincipalOut = 0;
  let documentCharges = 0;
  let repaymentsReceived = 0;
  let loanProfit = 0;

  const loanCards: MemberSummaryLoan[] = loans.map((loan) => {
    const documentCharge = loan.documentCharge || 0;
    const repaid = loan.repayments.reduce((sum, r) => sum + (r.amount || 0), 0);
    const profit = calculateLoanProfit(loan as any, loan.repayments as any);
    loanPrincipalOut += loan.amount || 0;
    documentCharges += documentCharge;
    repaymentsReceived += repaid;
    loanProfit += profit;
    activity.push(time(loan.disbursementDate));
    for (const r of loan.repayments) { activity.push(time(r.paidDate)); payments.push(time(r.paidDate)); }

    // A period counts as paid by an installment, not by interest-only or recovery receipts
    // (the recovery-aware rule in app/api/loans/consolidated/route.ts `settlesPeriod`).
    const installmentsPaid = new Set(
      loan.repayments.filter((r) => r.period > 0 && !INTEREST_ONLY.includes(r.paymentType) && r.paymentType !== 'RECOVERY').map((r) => r.period),
    ).size;
    const last = loan.repayments.reduce<number | null>((max, r) => (max === null || time(r.paidDate) > max ? time(r.paidDate) : max), null);

    return {
      id: loan.id,
      loanType: loan.loanType,
      repaymentType: loan.repaymentType,
      status: loan.status,
      disbursementDate: iso(loan.disbursementDate),
      principal: round2(loan.amount),
      documentCharge: round2(documentCharge),
      // The LOAN_DISBURSEMENT ledger entry records amount − documentCharge as the cash given to the
      // member (app/api/loans/consolidated/route.ts:1123 actualDisbursementAmount).
      cashDisbursed: round2((loan.amount || 0) - documentCharge),
      totalRepaid: round2(repaid),
      profit: round2(profit),
      remainingAmount: round2(loan.remainingAmount),
      installmentsPaid,
      lastRepaymentDate: last === null ? null : new Date(last).toISOString(),
      recovery: loan.nonRecoverableAt
        ? {
            markedAt: iso(loan.nonRecoverableAt),
            reason: loan.nonRecoverableReason ?? null,
            principalAtMark: loan.recoveryPrincipalAtMark ?? null,
            duesAtMark: loan.recoveryDuesAtMark ?? null,
            interestOutstanding: round2(loan.recoveryInterestOutstanding || 0),
            recovered: round2(loan.recoveryAmount || 0),
            outcome: loan.recoveryOutcome ?? null,
          }
        : null,
    };
  });

  const moneyIn = contributionsPaid + repaymentsReceived;
  // Cash handed over for a loan is amount − documentCharge (the charge is withheld, see cashDisbursed).
  const moneyOut = loanPrincipalOut - documentCharges + auctionPayoutsOut;
  const valid = activity.filter((t) => !Number.isNaN(t));
  const validPayments = payments.filter((t) => !Number.isNaN(t));

  return {
    memberId: member.id,
    asOf: now.toISOString(),
    totals: {
      moneyIn: round2(moneyIn),
      moneyOut: round2(moneyOut),
      netCashFlow: round2(moneyIn - moneyOut),
      profit: round2(loanProfit + chitCommission),
      loanProfit: round2(loanProfit),
      chitCommission: round2(chitCommission),
      contributionsPaid: round2(contributionsPaid),
      repaymentsReceived: round2(repaymentsReceived),
      loanPrincipalOut: round2(loanPrincipalOut),
      auctionPayoutsOut: round2(auctionPayoutsOut),
      documentCharges: round2(documentCharges),
    },
    keyDates: {
      memberSince: iso(member.createdAt),
      firstActivity: valid.length ? new Date(valid.reduce((a, b) => Math.min(a, b))).toISOString() : null,
      lastPayment: validPayments.length ? new Date(validPayments.reduce((a, b) => Math.max(a, b))).toISOString() : null,
    },
    chits,
    loans: loanCards,
  };
}
