import { getChitExpectedContribution } from './duesTracker';

/**
 * Commission is locked in when a member takes the payout: the winner pays the full
 * term schedule and receives the payout once. It does not depend on membersCount,
 * enrolment or who the winner is.
 */
export interface CommissionFund {
  monthlyContribution: number;
  firstMonthContribution?: number | null;
  duration: number;
  chitFundType?: string;
}

/**
 * What one member pays over the whole term: Σ getChitExpectedContribution(fund, m) for
 * m = 1..duration, so month 1 uses firstMonthContribution ?? monthlyContribution for
 * every fund type (the same rule as the Dues Tracker and addContribution).
 */
export function getChitTermContribution(fund: CommissionFund): number {
  const duration = Math.max(0, Math.floor(fund.duration || 0));
  let total = 0;
  for (let month = 1; month <= duration; month++) {
    total += getChitExpectedContribution(fund, month);
  }
  return total;
}

/** Profit on one payout: the winner's term contribution minus what they receive. */
export function calculateChitPayoutCommission(
  fund: CommissionFund,
  payout: { amount: number; month?: number },
): number {
  // Keep a negative spread visible instead of silently hiding a payout loss.
  return getChitTermContribution(fund) - payout.amount;
}

/** A chit fund as the "up to current month" profit helpers need it. */
export type ChitProfitFund = CommissionFund & {
  currentMonth?: number | null;
  startDate?: string | Date | null;
};

/**
 * The fund month profit is counted up to: fund.currentMonth, or (when it is missing) the months
 * elapsed since startDate, capped at duration. Defaults to 1.
 */
export function resolveChitCurrentMonth(fund: ChitProfitFund, now: Date = new Date()): number {
  let currentMonth = fund.currentMonth || 1;
  if (!fund.currentMonth && fund.startDate) {
    const start = typeof fund.startDate === 'string' ? new Date(fund.startDate) : fund.startDate;
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

/**
 * The auctions whose commission is counted as profit: month <= current month and date <= now
 * (a missing month or date does not exclude an auction). Shared by
 * calculateChitFundProfitUpToCurrentMonth and calculateChitProfitReconciliation.
 */
export function getCountedChitAuctions<T extends { month?: number | null; date?: Date | string | null }>(
  fund: ChitProfitFund,
  auctions: T[],
  now: Date = new Date(),
): T[] {
  const currentMonth = resolveChitCurrentMonth(fund, now);
  return auctions.filter(a => (!a.month || a.month <= currentMonth) && (!a.date || new Date(a.date) <= now));
}

export interface ChitProfitReconciliation {
  /** Σ commission over counted auctions (same value as calculateChitFundProfitUpToCurrentMonth). */
  profit: number;
  /** Σ contributions − Σ every recorded auction payout. */
  netCash: number;
  /** Σ over counted winners of (term contribution × counted wins − what they have paid). */
  winnersStillOwe: number;
  /** Σ paid by members with no counted win (and contributions with no member). */
  heldForUnpaid: number;
  /** Σ payouts recorded but not yet counted (future month or date). */
  pendingPayouts: number;
}

/**
 * Explains profit in cash terms. Holds exactly:
 *   profit = netCash + winnersStillOwe − heldForUnpaid + pendingPayouts
 * At fund completion the adjustments are 0, so profit = inflow − outflow.
 */
export function calculateChitProfitReconciliation(
  fund: ChitProfitFund,
  contributions: { amount: number; memberId?: number | null }[],
  auctions: { amount: number; month?: number | null; date?: Date | string | null; winnerId?: number | null }[],
  options: { now?: Date } = {},
): ChitProfitReconciliation {
  const now = options.now ?? new Date();
  const term = getChitTermContribution(fund);
  const counted = getCountedChitAuctions(fund, auctions, now);
  const countedSet = new Set(counted);

  const profit = counted.reduce((sum, a) => sum + calculateChitPayoutCommission(fund, a), 0);
  const inflow = contributions.reduce((sum, c) => sum + c.amount, 0);
  const outflow = auctions.reduce((sum, a) => sum + a.amount, 0);
  const pendingPayouts = auctions.reduce((sum, a) => sum + (countedSet.has(a) ? 0 : a.amount), 0);

  const wins = new Map<number, number>();
  let ownerlessWins = 0;
  for (const a of counted) {
    if (a.winnerId == null) ownerlessWins++;
    else wins.set(a.winnerId, (wins.get(a.winnerId) || 0) + 1);
  }
  const paid = new Map<number, number>();
  let heldForUnpaid = 0;
  for (const c of contributions) {
    if (c.memberId != null && wins.has(c.memberId)) paid.set(c.memberId, (paid.get(c.memberId) || 0) + c.amount);
    else heldForUnpaid += c.amount; // no counted win, or no member on the contribution
  }
  // Raw sum: a winner who paid more than their term schedule (an overpayment) makes their
  // share negative. Clamping it would break the identity above. A counted auction with no
  // winner (not possible in the schema) still owes the full term, so profit reconciles.
  let winnersStillOwe = ownerlessWins * term;
  for (const [memberId, count] of wins) winnersStillOwe += term * count - (paid.get(memberId) || 0);

  return { profit, netCash: inflow - outflow, winnersStillOwe, heldForUnpaid, pendingPayouts };
}

export interface CommissionTrendFund extends CommissionFund {
  currentMonth: number;
  status: string;
  /** Used as the last-resort payout when more members remain than months (no plan row). */
  totalAmount?: number | null;
  fixedAmounts: { month: number; amount: number }[];
  contributions: { amount: number; paidDate: Date | string }[];
  auctions: { amount: number; month: number; date: Date | string; winnerId: number }[];
  members: { id: number }[];
  auctionBookings: { memberId: number; month: number }[];
}

/**
 * Payout amount for each member who has not won a counted auction yet, or null when a needed
 * fixed amount is unknown (non-Fixed funds, or a Fixed fund missing a plan row).
 *  (a) a booked member takes the fixed amount of the booked month;
 *  (b) the others take the next free months in order (not booked, not a counted auction);
 *  (c) past the last free month, the final month's amount (else totalAmount).
 */
function projectRemainingPayouts(fund: CommissionTrendFund, counted: CommissionTrendFund['auctions']): number[] | null {
  const winners = new Set(counted.map(a => a.winnerId));
  const remaining = fund.members.filter(m => !winners.has(m.id));
  if (remaining.length === 0) return [];
  if (fund.chitFundType !== 'Fixed') return null;
  // Bookings of members who already won are fulfilled or stale; they do not hold a month.
  const booked = new Map<number, number>();
  for (const b of fund.auctionBookings) if (!winners.has(b.memberId)) booked.set(b.memberId, b.month);
  const taken = new Set<number>([...counted.map(a => a.month), ...booked.values()]);
  const freeMonths: number[] = [];
  for (let month = 1; month <= fund.duration; month++) if (!taken.has(month)) freeMonths.push(month);
  const planAmount = (month: number) => fund.fixedAmounts.find(p => p.month === month)?.amount;

  const amounts: number[] = [];
  let nextFree = 0;
  for (const member of remaining) {
    const bookedMonth = booked.get(member.id);
    let amount: number | null | undefined;
    if (bookedMonth !== undefined) amount = planAmount(bookedMonth);
    else if (nextFree < freeMonths.length) amount = planAmount(freeMonths[nextFree++]);
    else amount = planAmount(fund.duration) ?? fund.totalAmount;
    if (amount == null) return null;
    amounts.push(amount);
  }
  return amounts;
}

export function calculateChitCommissionTrends(funds: CommissionTrendFund[], monthCount: number, now = new Date()) {
  const months = Array.from({ length: monthCount }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - monthCount + 1 + index, 1);
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      year: date.getFullYear(), month: date.getMonth() + 1,
      label: index === monthCount - 1 ? 'This month' : date.toLocaleString('en-IN', {
        month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: '2-digit' } : {}),
      }),
      commission: 0, auctionCount: 0,
    };
  });
  let commission = 0;
  let collections = 0;
  let payouts = 0;
  let expectedRemainingCommission = 0;
  let projectionComplete = true;
  for (const fund of funds) {
    const completed = fund.auctions.filter(a => new Date(a.date) <= now && a.month <= fund.currentMonth);
    collections += fund.contributions.filter(c => new Date(c.paidDate) <= now).reduce((sum, c) => sum + c.amount, 0);
    for (const payout of completed) {
      const amount = calculateChitPayoutCommission(fund, payout);
      commission += amount;
      payouts += payout.amount;
      const date = new Date(payout.date);
      const row = months.find(m => m.year === date.getFullYear() && m.month === date.getMonth() + 1);
      if (row) { row.commission += amount; row.auctionCount += 1; }
    }
    if (fund.status === 'Completed' || fund.status === 'Cancelled') continue;
    // Remaining payouts = members not yet paid out (not unauctioned months).
    const remaining = projectRemainingPayouts(fund, completed);
    if (remaining === null) projectionComplete = false;
    else for (const amount of remaining) expectedRemainingCommission += calculateChitPayoutCommission(fund, { amount });
  }
  return { months, summary: {
    commission, collections, payouts, collectionPayoutBalance: collections - payouts,
    expectedRemainingCommission: projectionComplete ? expectedRemainingCommission : null,
  } };
}
