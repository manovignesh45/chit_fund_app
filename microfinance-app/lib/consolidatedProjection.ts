/**
 * Consolidated calendar-month cash flow projection across all loans and chit funds.
 */

import {
  ChitFundForAggregation,
  LoanForAggregation,
  CalendarMonth,
  computeExpectedLoanRepayment,
  computeExpectedChitContribution,
  generateCalendarMonths,
  getProjectionEndDate,
  getFundMonthCalendarDate,
  isDateInCalendarMonth,
  isCalendarMonthOnOrAfter,
  fundHasContributionInCalendarMonth,
} from './monthlyAggregations';
import { getPrizeAmountPerWinner } from './auctionProjection';
import {
  computeChitMemberDuePeriods,
  computeLoanDuePeriods,
  getLoanInstallment,
  type ContributionLike,
  type DuePeriod,
  type LoanLike,
} from './duesTracker';

export interface ChitFundWithBookings extends ChitFundForAggregation {
  totalAmount: number;
  fixedAmounts?: { month: number; amount: number }[];
  auctionBookings: { month: number; memberId: number; memberName: string }[];
}

export interface ConsolidatedSimulationOptions {
  fundId: number;
  fromYear: number;
  fromMonth: number;
  contribution: number;
}

export interface ConsolidatedProjectionRow {
  year: number;
  month: number;
  label: string;
  expectedLoanRepayments: number;
  expectedChitContributions: number;
  totalExpectedCollection: number;
  totalAuctionPayout: number;
  net: number;
  cumulativeBalance: number;
  isCurrentMonth?: boolean;
  /**
   * The single month immediately preceding the current one, shown for context.
   * Its collection and payout figures are what was actually recorded, and its
   * cumulative balance is the real closing balance.
   */
  isPastMonth?: boolean;
  /**
   * Current month only: what has already happened this month. The row's own
   * collection/payout columns then hold only what is still to come, and its
   * cumulative balance is today's real balance plus that.
   */
  monthToDate?: {
    balanceToday: number;
    loanRepaymentsReceived: number;
    chitContributionsReceived: number;
    auctionPayoutsPaid: number;
    /** Included in this month's collection: unpaid dues from earlier months */
    overdueFromEarlierMonths: number;
  };
  /** Whether isPastMonth's cumulativeBalance is a rough estimate rather than a real recorded balance */
  isPastBalanceEstimated?: boolean;
  /** Payout breakdown by fund name for tooltips/detail */
  auctionPayoutDetails?: { fundName: string; amount: number; bookedCount: number }[];
  /** Members booked or actual winners for auction payout in this calendar month */
  bookedMembers?: {
    fundId: number;
    fundName: string;
    memberName: string;
    fundMonth: number;
    payoutAmount: number;
    isActual?: boolean;
  }[];
}

export interface ActualAuctionRecord {
  chitFundId: number;
  fundName: string;
  amount: number;
  date: Date | string;
  memberName: string;
  fundMonth: number;
  /** Member id of the winner — used to tell who still has no auction assigned */
  winnerId: number;
}

/** Expected future payouts for one fund's members who have neither booked nor won yet. */
export interface UnbookedFundLiability {
  fundId: number;
  fundName: string;
  unbookedCount: number;
  amount: number;
  months: { fundMonth: number; amount: number }[];
}

/** Money already recorded in a calendar month, from the transaction ledger. */
export interface RecordedMonthTotals {
  loanRepayments: number;
  chitContributions: number;
}

/**
 * What members still owe up to the end of this month, the same way the Dues
 * Tracker counts it: unpaid instalments falling due this month, plus older
 * ones that are still unpaid.
 */
export interface OutstandingDues {
  loanRepayments: number;
  chitContributions: number;
  /** Part of the two figures above that fell due before this calendar month */
  fromEarlierMonths: number;
}

export interface ConsolidatedProjectionOptions {
  actualAuctions?: ActualAuctionRecord[];
  /** Today's real total balance (the same figure the dashboard shows) */
  openingBalance?: number;
  /** Real balance at the end of the month before the current one (by transaction date) */
  pastMonthClosingBalance?: number;
  /** Ledger totals for last month, shown as that row's actual figures */
  pastMonthRecorded?: RecordedMonthTotals;
  /** Ledger totals for this month so far */
  currentMonthRecorded?: RecordedMonthTotals;
  /** Still owed up to the end of this month; without it the whole month's schedule is assumed outstanding */
  currentMonthOutstanding?: OutstandingDues;
  simulation?: ConsolidatedSimulationOptions;
}

/**
 * Sums what is still owed up to `monthEnd` using the Dues Tracker's own rules,
 * split into this month's dues and older unpaid ones.
 */
export function computeOutstandingDues(
  loans: (LoanLike & { id: number })[],
  chitFunds: { startDate: Date | string; duration: number; monthlyContribution?: number | null; firstMonthContribution?: number | null; members: { contributions: ContributionLike[] }[] }[],
  monthStart: Date,
  monthEnd: Date,
  asOf: Date = new Date()
): OutstandingDues {
  const range = { start: new Date(0), end: monthEnd };
  let loanRepayments = 0;
  let chitContributions = 0;
  let fromEarlierMonths = 0;
  const add = (periods: DuePeriod[]) => {
    let sum = 0;
    for (const p of periods) {
      sum += p.outstanding;
      if (new Date(p.dueDate) < monthStart) fromEarlierMonths += p.outstanding;
    }
    return sum;
  };
  for (const loan of loans) loanRepayments += add(computeLoanDuePeriods(loan, range, asOf));
  for (const fund of chitFunds) {
    for (const member of fund.members) {
      chitContributions += add(computeChitMemberDuePeriods(fund, member.contributions, range, asOf));
    }
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    loanRepayments: round2(loanRepayments),
    chitContributions: round2(chitContributions),
    fromEarlierMonths: round2(fromEarlierMonths),
  };
}

function isCurrentCalendarMonth(
  year: number,
  month: number,
  now = new Date()
): boolean {
  return year === now.getFullYear() && month === now.getMonth() + 1;
}

function isPreviousCalendarMonth(
  year: number,
  month: number,
  now = new Date()
): boolean {
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return year === prev.getFullYear() && month === prev.getMonth() + 1;
}

function getActualAuctionsForCalendarMonth(
  actualAuctions: ActualAuctionRecord[],
  year: number,
  month: number
): ActualAuctionRecord[] {
  return actualAuctions.filter((a) => {
    const d = new Date(a.date);
    return isDateInCalendarMonth(d, year, month);
  });
}

function buildActualPayoutDetails(
  actuals: ActualAuctionRecord[]
): { total: number; details: { fundName: string; amount: number; bookedCount: number }[]; members: ConsolidatedProjectionRow['bookedMembers'] } {
  const byFund = new Map<string, { amount: number; count: number }>();
  const members: NonNullable<ConsolidatedProjectionRow['bookedMembers']> = [];

  for (const a of actuals) {
    const existing = byFund.get(a.fundName) || { amount: 0, count: 0 };
    existing.amount += a.amount;
    existing.count += 1;
    byFund.set(a.fundName, existing);

    members.push({
      fundId: a.chitFundId,
      fundName: a.fundName,
      memberName: a.memberName,
      fundMonth: a.fundMonth,
      payoutAmount: a.amount,
      isActual: true,
    });
  }

  const details = [...byFund.entries()].map(([fundName, { amount, count }]) => ({
    fundName,
    amount,
    bookedCount: count,
  }));

  return {
    total: actuals.reduce((s, a) => s + a.amount, 0),
    details,
    members,
  };
}

/** Shape getPrizeAmountPerWinner expects, built from a projection input fund. */
function toProjectionFund(fund: ChitFundWithBookings) {
  return {
    totalAmount: fund.totalAmount,
    monthlyContribution: fund.monthlyContribution,
    firstMonthContribution: fund.firstMonthContribution,
    duration: fund.duration,
    chitFundType: fund.chitFundType,
    memberCount: fund.members.length,
    fixedAmounts: fund.fixedAmounts,
  };
}

export function getBookedMembersForCalendarMonth(
  chitFunds: (ChitFundWithBookings & { name?: string })[],
  year: number,
  month: number
): ConsolidatedProjectionRow['bookedMembers'] {
  const booked: NonNullable<ConsolidatedProjectionRow['bookedMembers']> = [];

  for (const fund of chitFunds) {
    const monthBookings = fund.auctionBookings.filter((b) => {
      const calDate = getFundMonthCalendarDate(fund.startDate, b.month);
      return isDateInCalendarMonth(calDate, year, month);
    });

    for (const booking of monthBookings) {
      const prizePerWinner = getPrizeAmountPerWinner(
        toProjectionFund(fund),
        booking.month
      );

      booked.push({
        fundId: fund.id,
        fundName: fund.name || `Fund ${fund.id}`,
        memberName: booking.memberName,
        fundMonth: booking.month,
        payoutAmount: prizePerWinner,
        isActual: false,
      });
    }
  }

  return booked;
}

/**
 * Booked members for a calendar month, excluding any booking whose fund+fund-month
 * already has a recorded actual auction (a stale booking left over after the real
 * payout was entered elsewhere, without the booking being removed).
 */
export function getPendingBookedMembersForCalendarMonth(
  chitFunds: (ChitFundWithBookings & { name?: string })[],
  year: number,
  month: number,
  actualAuctions: ActualAuctionRecord[]
): ConsolidatedProjectionRow['bookedMembers'] {
  const supersededKeys = new Set(
    actualAuctions.map((a) => `${a.chitFundId}-${a.fundMonth}`)
  );

  const allBooked = getBookedMembersForCalendarMonth(chitFunds, year, month) || [];
  return allBooked.filter(
    (b) => !supersededKeys.has(`${b.fundId}-${b.fundMonth}`)
  );
}

/**
 * What the members who have neither booked nor won an auction yet will still cost.
 *
 * The month-by-month projection only knows about members with an actual
 * AuctionBooking, so anyone not yet booked contributes nothing to any row's
 * payout — leaving the final cumulative balance optimistic by their whole
 * future payout. Every member takes a payout eventually, so we price them
 * here: each still-open fund month has a predefined amount (fixed funds), and
 * we assume the unbooked members take the open months at the end of the fund.
 *
 * This is deliberately kept out of the projection rows themselves — the table
 * stays a view of what's actually booked, and this total is subtracted once at
 * the summary level.
 */
export function computeUnbookedAuctionLiability(
  chitFunds: (ChitFundWithBookings & { name?: string })[],
  actualAuctions: ActualAuctionRecord[] = []
): { total: number; totalMembers: number; byFund: UnbookedFundLiability[] } {
  const byFund: UnbookedFundLiability[] = [];

  for (const fund of chitFunds) {
    const fundAuctions = actualAuctions.filter((a) => a.chitFundId === fund.id);

    const assignedMemberIds = new Set<number>([
      ...fund.auctionBookings.map((b) => b.memberId),
      ...fundAuctions.map((a) => a.winnerId),
    ]);
    const unbookedCount = Math.max(
      0,
      fund.members.length - assignedMemberIds.size
    );
    if (unbookedCount === 0) continue;

    const takenMonths = new Set<number>([
      ...fund.auctionBookings.map((b) => b.month),
      ...fundAuctions.map((a) => a.fundMonth),
    ]);
    const openMonths: number[] = [];
    for (let m = 1; m <= fund.duration; m++) {
      if (!takenMonths.has(m)) openMonths.push(m);
    }

    // Unbooked members are assumed to take their auction at the end of the
    // fund, so bill them against the *last* open months. If the schedule has
    // fewer open months than unbooked members (a data inconsistency), the
    // extras are priced at the final month rather than silently dropped.
    const chosenMonths = openMonths.slice(-unbookedCount);
    while (chosenMonths.length < unbookedCount) {
      chosenMonths.push(fund.duration);
    }

    const projectionFund = toProjectionFund(fund);
    const months = chosenMonths.map((fundMonth) => ({
      fundMonth,
      amount: getPrizeAmountPerWinner(projectionFund, fundMonth),
    }));

    byFund.push({
      fundId: fund.id,
      fundName: fund.name || `Fund ${fund.id}`,
      unbookedCount,
      amount: months.reduce((s, m) => s + m.amount, 0),
      months,
    });
  }

  return {
    total: byFund.reduce((s, f) => s + f.amount, 0),
    totalMembers: byFund.reduce((s, f) => s + f.unbookedCount, 0),
    byFund,
  };
}

function groupByFund(
  entries: NonNullable<ConsolidatedProjectionRow['bookedMembers']>
): { fundName: string; amount: number; bookedCount: number }[] {
  const byFund = new Map<string, { amount: number; count: number }>();
  for (const e of entries) {
    const existing = byFund.get(e.fundName) || { amount: 0, count: 0 };
    existing.amount += e.payoutAmount;
    existing.count += 1;
    byFund.set(e.fundName, existing);
  }
  return [...byFund.entries()].map(([fundName, { amount, count }]) => ({
    fundName,
    amount,
    bookedCount: count,
  }));
}

function getSimulatedChitExtra(
  chitFunds: ChitFundForAggregation[],
  year: number,
  month: number,
  simulation?: ConsolidatedSimulationOptions
): number {
  if (!simulation) return 0;
  if (!isCalendarMonthOnOrAfter(year, month, simulation.fromYear, simulation.fromMonth)) {
    return 0;
  }
  const fund = chitFunds.find((f) => f.id === simulation.fundId);
  if (!fund) return 0;
  if (!fundHasContributionInCalendarMonth(fund, year, month)) return 0;
  return simulation.contribution;
}

export function computeConsolidatedProjection(
  loansInput: LoanForAggregation[],
  chitFunds: (ChitFundWithBookings & { name?: string })[],
  options: ConsolidatedProjectionOptions = {}
): ConsolidatedProjectionRow[] {
  const {
    actualAuctions = [],
    openingBalance = 0,
    pastMonthClosingBalance,
    pastMonthRecorded,
    currentMonthRecorded,
    currentMonthOutstanding,
    simulation,
  } = options;
  // Reducing Balance loans have no fixed instalment; they pay the month's
  // interest on what is still outstanding (same rule as the Dues Tracker).
  const loans = loansInput.map((loan) => ({
    ...loan,
    installmentAmount: getLoanInstallment({ ...loan, repayments: [] }),
  }));
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const rangeEnd = getProjectionEndDate(chitFunds);
  const calendarMonths = generateCalendarMonths(rangeStart, rangeEnd);

  const rows: ConsolidatedProjectionRow[] = [];
  // The chain starts from today's real balance — the same figure the
  // dashboard shows. Everything already recorded (this month's collections,
  // auction payouts, new loans given out, expenses) is inside it, so the
  // current month only adds what is still to come, and every later month
  // builds on from there.
  let cumulativeBalance = openingBalance;
  // Anything still pending from last month is an overdue liability: it's
  // not in today's balance (never paid) and last month's row is not part of
  // the forward chain, so carry it into this month to have it subtracted.
  let carriedOverPending: NonNullable<ConsolidatedProjectionRow['bookedMembers']> = [];

  for (const cal of calendarMonths) {
    const isCurrent = isCurrentCalendarMonth(cal.year, cal.month, now);
    const isPastMonth = isPreviousCalendarMonth(cal.year, cal.month, now);
    const simulatedExtra = getSimulatedChitExtra(chitFunds, cal.year, cal.month, simulation);

    if (isPastMonth) {
      // Last month is history: show what was actually recorded and its real closing balance.
      const actualPayout = buildActualPayoutDetails(
        getActualAuctionsForCalendarMonth(actualAuctions, cal.year, cal.month)
      );
      const pendingBooked = getPendingBookedMembersForCalendarMonth(
        chitFunds,
        cal.year,
        cal.month,
        actualAuctions
      ) || [];
      carriedOverPending = pendingBooked;

      const loanRepayments = pastMonthRecorded
        ? pastMonthRecorded.loanRepayments
        : computeExpectedLoanRepayment(loans, cal.start, cal.end);
      const chitContributions = pastMonthRecorded
        ? pastMonthRecorded.chitContributions
        : computeExpectedChitContribution(chitFunds, cal.start, cal.end);
      const totalCollection = loanRepayments + chitContributions;
      const bookedMembers = [...(actualPayout.members || []), ...pendingBooked];
      const pastBalanceIsEstimated = pastMonthClosingBalance === undefined;

      rows.push({
        year: cal.year,
        month: cal.month,
        label: cal.label,
        expectedLoanRepayments: loanRepayments,
        expectedChitContributions: chitContributions,
        totalExpectedCollection: totalCollection,
        totalAuctionPayout: actualPayout.total,
        net: totalCollection - actualPayout.total,
        cumulativeBalance: pastBalanceIsEstimated ? openingBalance : pastMonthClosingBalance,
        isCurrentMonth: false,
        isPastMonth: true,
        isPastBalanceEstimated: pastBalanceIsEstimated,
        auctionPayoutDetails: groupByFund(bookedMembers),
        bookedMembers,
      });
      continue;
    }

    let expectedLoanRepayments: number;
    let expectedChitContributions: number;
    let totalAuctionPayout: number;
    let bookedMembers: NonNullable<ConsolidatedProjectionRow['bookedMembers']>;
    let monthToDate: ConsolidatedProjectionRow['monthToDate'];

    if (isCurrent) {
      // Only what is still to come this month — the rest is already in today's balance.
      expectedLoanRepayments = currentMonthOutstanding
        ? currentMonthOutstanding.loanRepayments
        : computeExpectedLoanRepayment(loans, cal.start, cal.end);
      expectedChitContributions =
        (currentMonthOutstanding
          ? currentMonthOutstanding.chitContributions
          : computeExpectedChitContribution(chitFunds, cal.start, cal.end)) + simulatedExtra;

      const actualPayout = buildActualPayoutDetails(
        getActualAuctionsForCalendarMonth(actualAuctions, cal.year, cal.month)
      );
      const pendingBooked = getPendingBookedMembersForCalendarMonth(
        chitFunds,
        cal.year,
        cal.month,
        actualAuctions
      ) || [];
      const stillToPay = [...pendingBooked, ...carriedOverPending];

      // Paid winners stay listed (marked paid) but are not subtracted again.
      bookedMembers = [...(actualPayout.members || []), ...stillToPay];
      totalAuctionPayout = stillToPay.reduce((s, b) => s + b.payoutAmount, 0);
      monthToDate = {
        balanceToday: openingBalance,
        loanRepaymentsReceived: currentMonthRecorded?.loanRepayments ?? 0,
        chitContributionsReceived: currentMonthRecorded?.chitContributions ?? 0,
        auctionPayoutsPaid: actualPayout.total,
        overdueFromEarlierMonths: currentMonthOutstanding?.fromEarlierMonths ?? 0,
      };
    } else {
      expectedLoanRepayments = computeExpectedLoanRepayment(loans, cal.start, cal.end);
      expectedChitContributions =
        computeExpectedChitContribution(chitFunds, cal.start, cal.end) + simulatedExtra;
      bookedMembers = getBookedMembersForCalendarMonth(chitFunds, cal.year, cal.month) || [];
      totalAuctionPayout = bookedMembers.reduce((s, b) => s + b.payoutAmount, 0);
    }

    const totalExpectedCollection = expectedLoanRepayments + expectedChitContributions;
    const net = totalExpectedCollection - totalAuctionPayout;
    cumulativeBalance += net;

    rows.push({
      year: cal.year,
      month: cal.month,
      label: cal.label,
      expectedLoanRepayments,
      expectedChitContributions,
      totalExpectedCollection,
      totalAuctionPayout,
      net,
      cumulativeBalance,
      isCurrentMonth: isCurrent,
      isPastMonth: false,
      auctionPayoutDetails: groupByFund(bookedMembers),
      bookedMembers,
      monthToDate,
    });
  }

  return rows;
}

export function computeBaselineAndSimulated(
  loans: LoanForAggregation[],
  chitFunds: (ChitFundWithBookings & { name?: string })[],
  options: ConsolidatedProjectionOptions = {}
): {
  projection: ConsolidatedProjectionRow[];
  simulatedProjection: ConsolidatedProjectionRow[] | null;
} {
  const { simulation, ...baseOptions } = options;
  const projection = computeConsolidatedProjection(loans, chitFunds, baseOptions);
  const simulatedProjection = simulation
    ? computeConsolidatedProjection(loans, chitFunds, { ...baseOptions, simulation })
    : null;
  return { projection, simulatedProjection };
}
