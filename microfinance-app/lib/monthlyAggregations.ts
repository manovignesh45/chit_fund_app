/**
 * Shared monthly expected collection logic (loan repayments + chit contributions).
 * Used by dashboard aggregations and consolidated cash flow projection.
 */

export interface LoanForAggregation {
  id: number;
  installmentAmount: number;
  loanType?: string | null;
  remainingAmount?: number | null;
  interestPercentage?: number | null;
  disbursementDate: Date | string;
  duration: number;
  repaymentType: string;
}

export interface ChitFundForAggregation {
  id: number;
  startDate: Date | string;
  duration: number;
  monthlyContribution: number;
  members: { id: number }[];
  firstMonthContribution?: number | null;
  chitFundType?: string;
}

/**
 * A loan's regular instalment. Reducing Balance loans have no fixed instalment
 * stored; each month they owe the interest on what is still outstanding.
 * Shared with the Dues Tracker (duesTracker.getLoanInstallment) so every
 * screen expects the same amount.
 */
export function getMonthlyLoanInstallment(loan: {
  installmentAmount?: number | null;
  loanType?: string | null;
  repaymentType?: string | null;
  remainingAmount?: number | null;
  interestPercentage?: number | null;
}): number {
  if (loan.installmentAmount) return loan.installmentAmount;
  const reducing = loan.loanType === 'Reducing Balance' || loan.repaymentType === 'Reducing Balance';
  return reducing
    ? Math.round(((loan.remainingAmount || 0) * ((loan.interestPercentage || 0) / 100)) / 12)
    : 0;
}

/** Contribution one member owes for a fund month: month 1 uses the first-month amount. */
export function getMemberContributionForMonth(
  fund: { monthlyContribution?: number | null; firstMonthContribution?: number | null },
  month: number
): number {
  const monthly = fund.monthlyContribution || 0;
  return month === 1 ? (fund.firstMonthContribution ?? monthly) : monthly;
}

/** Map a chit fund's month-of-fund (1-based) to its calendar payment date. */
export function getFundMonthCalendarDate(
  startDate: Date | string,
  fundMonth: number
): Date {
  const d = new Date(startDate);
  d.setMonth(d.getMonth() + (fundMonth - 1));
  return d;
}

/** Whether a date falls within a calendar month window (inclusive). */
export function isDateInCalendarMonth(
  date: Date,
  year: number,
  month: number
): boolean {
  return date.getFullYear() === year && date.getMonth() === month - 1;
}

export function computeExpectedLoanRepayment(
  allLoans: LoanForAggregation[],
  startDate: Date,
  endDate: Date
): number {
  let expectedLoanRepayment = 0;

  for (const loan of allLoans) {
    const installment = getMonthlyLoanInstallment(loan);
    const loanTermEnd = new Date(loan.disbursementDate);
    let paymentDate = new Date(loan.disbursementDate);

    if (loan.repaymentType === 'Weekly') {
      loanTermEnd.setDate(loanTermEnd.getDate() + (loan.duration || 0) * 7);
      paymentDate.setDate(paymentDate.getDate() + 7);
      while (paymentDate <= endDate && paymentDate <= loanTermEnd) {
        if (paymentDate >= startDate) {
          expectedLoanRepayment += installment;
        }
        paymentDate.setDate(paymentDate.getDate() + 7);
      }
    } else {
      loanTermEnd.setMonth(loanTermEnd.getMonth() + (loan.duration || 0));
      paymentDate.setMonth(paymentDate.getMonth() + 1);
      while (paymentDate <= endDate && paymentDate <= loanTermEnd) {
        if (paymentDate >= startDate) {
          expectedLoanRepayment += installment;
        }
        paymentDate.setMonth(paymentDate.getMonth() + 1);
      }
    }
  }

  return expectedLoanRepayment;
}

export function computeExpectedChitContribution(
  allChitFunds: ChitFundForAggregation[],
  startDate: Date,
  endDate: Date
): number {
  let expectedChitContribution = 0;

  for (const cf of allChitFunds) {
    const contribution = cf.monthlyContribution || 0;
    const membersCount = cf.members.length;
    const chitTermEnd = new Date(cf.startDate);
    chitTermEnd.setMonth(chitTermEnd.getMonth() + (cf.duration || 0));
    let paymentDate = new Date(cf.startDate);
    let month = 1;

    while (
      paymentDate <= endDate &&
      paymentDate < chitTermEnd &&
      month <= cf.duration
    ) {
      if (paymentDate >= startDate) {
        // Every member pays the first-month amount in month 1 (same rule as the Dues Tracker).
        expectedChitContribution += getMemberContributionForMonth(cf, month) * membersCount;
      }
      paymentDate.setMonth(paymentDate.getMonth() + 1);
      month++;
    }
  }

  return expectedChitContribution;
}

/** Full aggregations including actuals — for dashboard reuse. */
export function computeAggregations(
  allLoans: LoanForAggregation[],
  allChitFunds: ChitFundForAggregation[],
  repaymentMap: Map<string, number>,
  contributionMap: Map<string, number>,
  startDate: Date,
  endDate: Date
) {
  let expectedLoanRepayment = 0;
  const periodsInRange = new Set<string>();

  for (const loan of allLoans) {
    const installment = getMonthlyLoanInstallment(loan);
    const loanTermEnd = new Date(loan.disbursementDate);
    let paymentDate = new Date(loan.disbursementDate);
    let period = 1;

    if (loan.repaymentType === 'Weekly') {
      loanTermEnd.setDate(loanTermEnd.getDate() + (loan.duration || 0) * 7);
      paymentDate.setDate(paymentDate.getDate() + 7);
      while (paymentDate <= endDate && paymentDate <= loanTermEnd) {
        if (paymentDate >= startDate) {
          expectedLoanRepayment += installment;
          periodsInRange.add(`${loan.id}-${period}`);
        }
        paymentDate.setDate(paymentDate.getDate() + 7);
        period++;
      }
    } else {
      loanTermEnd.setMonth(loanTermEnd.getMonth() + (loan.duration || 0));
      paymentDate.setMonth(paymentDate.getMonth() + 1);
      while (paymentDate <= endDate && paymentDate <= loanTermEnd) {
        if (paymentDate >= startDate) {
          expectedLoanRepayment += installment;
          periodsInRange.add(`${loan.id}-${period}`);
        }
        paymentDate.setMonth(paymentDate.getMonth() + 1);
        period++;
      }
    }
  }

  const actualLoanRepayment = [...periodsInRange].reduce(
    (sum, key) => sum + (repaymentMap.get(key) || 0),
    0
  );

  let expectedChitContribution = 0;
  const chitMonthsInRange = new Set<string>();

  for (const cf of allChitFunds) {
    const contribution = cf.monthlyContribution || 0;
    const membersCount = cf.members.length;
    const chitTermEnd = new Date(cf.startDate);
    chitTermEnd.setMonth(chitTermEnd.getMonth() + (cf.duration || 0));
    let paymentDate = new Date(cf.startDate);
    let month = 1;

    while (
      paymentDate <= endDate &&
      paymentDate < chitTermEnd &&
      month <= cf.duration
    ) {
      if (paymentDate >= startDate) {
        expectedChitContribution += getMemberContributionForMonth(cf, month) * membersCount;
        chitMonthsInRange.add(`${cf.id}-${month}`);
      }
      paymentDate.setMonth(paymentDate.getMonth() + 1);
      month++;
    }
  }

  const actualChitContribution = [...chitMonthsInRange].reduce(
    (sum, key) => sum + (contributionMap.get(key) || 0),
    0
  );

  return {
    expectedLoanRepayment,
    actualLoanRepayment,
    expectedChitContribution,
    actualChitContribution,
    totalExpectedAmount: expectedLoanRepayment + expectedChitContribution,
    totalActualAmount: actualLoanRepayment + actualChitContribution,
  };
}

export interface CalendarMonth {
  year: number;
  month: number;
  label: string;
  start: Date;
  end: Date;
}

/** Label a calendar month as "This month" (if current) or "Month Year". */
export function formatCalendarMonthLabel(
  year: number,
  month: number,
  now: Date = new Date()
): string {
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  if (isCurrent) return 'This month';
  return new Date(year, month - 1, 1).toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  });
}

/** Generate calendar months from start (inclusive) to end (inclusive), by month. */
export function generateCalendarMonths(from: Date, to: Date): CalendarMonth[] {
  const months: CalendarMonth[] = [];
  let y = from.getFullYear();
  let m = from.getMonth();
  const endY = to.getFullYear();
  const endM = to.getMonth();

  while (y < endY || (y === endY && m <= endM)) {
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0, 23, 59, 59, 999);
    months.push({
      year: y,
      month: m + 1,
      label: formatCalendarMonthLabel(y, m + 1),
      start,
      end,
    });
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return months;
}

/** Latest calendar month any active chit fund still has collections. */
export function getProjectionEndDate(
  chitFunds: { startDate: Date | string; duration: number }[]
): Date {
  let latest = new Date();
  for (const fund of chitFunds) {
    const lastPayment = getFundMonthCalendarDate(fund.startDate, fund.duration);
    if (lastPayment > latest) {
      latest = lastPayment;
    }
  }
  return latest;
}

export function isCalendarMonthOnOrAfter(
  year: number,
  month: number,
  fromYear: number,
  fromMonth: number
): boolean {
  return year > fromYear || (year === fromYear && month >= fromMonth);
}

/** Whether a chit fund has a contribution due in a given calendar month. */
export function fundHasContributionInCalendarMonth(
  fund: ChitFundForAggregation,
  year: number,
  month: number
): boolean {
  for (let m = 1; m <= fund.duration; m++) {
    const paymentDate = getFundMonthCalendarDate(fund.startDate, m);
    if (isDateInCalendarMonth(paymentDate, year, month)) {
      return true;
    }
  }
  return false;
}
