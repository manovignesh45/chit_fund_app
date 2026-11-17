// Run with: node tests/trends-calculations.js. No database connection or writes.
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', jsx: 'react-jsx' });
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { calculateChitPayoutCommission, calculateChitCommissionTrends, getChitTermContribution, calculateChitProfitReconciliation } = require('../lib/chitCommission');
const { calculateChitFundProfit, calculateChitFundProfitUpToCurrentMonth, calculateLoanProfit } = require('../lib/financialUtils');
const { calculateTotalFinancialMetrics, calculatePeriodFinancialMetrics } = require('../lib/centralizedFinancialCalculations');
const LoanReturn = require('../app/components/BusinessROICard').default;
const BusinessEarnings = require('../app/components/YieldMetricsCard').default;
const CapitalPosition = require('../app/components/CapitalUtilizationCard').default;

// Term contribution = 5,000 + 4,800 × (3 − 1) = 14,600; commission = 14,600 − payout.
// Payouts are larger than this short term's schedule, so every commission here is a loss.
const fund = {
  monthlyContribution: 4800, firstMonthContribution: 5000, membersCount: 10,
  chitFundType: 'Fixed', currentMonth: 2, duration: 3, status: 'Active',
  fixedAmounts: [{ month: 1, amount: 40000 }, { month: 2, amount: 45000 }, { month: 3, amount: 47000 }],
  auctions: [
    { id: 1, month: 1, amount: 40000, date: new Date('2026-08-15'), winnerId: 1 },
    { id: 2, month: 2, amount: 45000, date: new Date('2026-09-15'), winnerId: 2 },
  ],
  contributions: [{ id: 1, month: 1, amount: 48200, paidDate: new Date('2026-08-10') }],
  // Members 1 and 2 have won; member 3 is the one payout left (next free month 3).
  members: [{ id: 1 }, { id: 2 }, { id: 3 }],
  auctionBookings: [],
};

test('commission is the term contribution minus the payout, for every fund type', () => {
  assert.equal(getChitTermContribution(fund), 14600);
  assert.equal(calculateChitPayoutCommission(fund, fund.auctions[0]), -25400); // 14,600 − 40,000
  assert.equal(calculateChitPayoutCommission(fund, fund.auctions[1]), -30400); // 14,600 − 45,000
  // No first-month override: 4,800 × 3 = 14,400
  assert.equal(calculateChitPayoutCommission({ ...fund, firstMonthContribution: null }, fund.auctions[0]), -25600);
  // The first-month override applies to Auction funds too (same rule as the Dues Tracker)
  assert.equal(calculateChitPayoutCommission({ ...fund, chitFundType: 'Auction' }, fund.auctions[0]), -25400);
  assert.equal(calculateChitPayoutCommission(fund, { month: 2, amount: 49000 }), -34400);
  // Independent of membersCount / enrolment and of the payout month
  assert.equal(calculateChitPayoutCommission({ ...fund, membersCount: 1 }, fund.auctions[0]), -25400);
  assert.equal(calculateChitPayoutCommission(fund, { month: 3, amount: 40000 }), -25400);
  // Missing or non-positive duration collects nothing
  assert.equal(getChitTermContribution({ ...fund, duration: 0 }), 0);
  assert.equal(getChitTermContribution({ ...fund, duration: -2 }), 0);
  assert.equal(getChitTermContribution({ ...fund, duration: undefined }), 0);
});

test('unpaid payout cash and member contributions are not income', () => {
  assert.equal(calculateChitFundProfit(fund, fund.contributions, []), 0);
  assert.equal(calculateChitFundProfitUpToCurrentMonth(fund, fund.contributions, []), 0);
  assert.equal(calculateChitFundProfitUpToCurrentMonth(fund, fund.contributions, fund.auctions), -55800);
  assert.equal(calculateChitFundProfitUpToCurrentMonth({ ...fund, currentMonth: 1 }, [], fund.auctions), -25400);
  assert.equal(calculateChitFundProfit(fund, [], [{ amount: 49000, month: 2 }]), -34400);
});

test('monthly commission and lifetime total reconcile; projection is separate', () => {
  const result = calculateChitCommissionTrends([fund], 6, new Date('2026-10-08'));
  assert.equal(result.months.length, 6);
  assert.equal(result.months.reduce((sum, row) => sum + row.commission, 0), result.summary.commission);
  assert.equal(result.summary.commission, -55800);
  assert.equal(result.summary.expectedRemainingCommission, -32400); // month 3 plan: 14,600 − 47,000
  assert.equal(result.summary.collectionPayoutBalance, -36800);
  assert.equal(result.months.find(row => row.key === '2026-08').commission, -25400);
  assert.equal(result.months.find(row => row.key === '2026-09').commission, -30400);
});

test('missing schedules are unknown, and future payouts and collections are excluded', () => {
  assert.equal(calculateChitCommissionTrends([{ ...fund, fixedAmounts: [] }], 6).summary.expectedRemainingCommission, null);
  const result = calculateChitCommissionTrends([{
    ...fund, currentMonth: 3,
    auctions: [...fund.auctions, { month: 3, amount: 47000, date: '2026-11-01', winnerId: 3 }],
    contributions: [...fund.contributions, { amount: 1000, paidDate: '2026-11-01' }],
  }], 6, new Date('2026-10-08'));
  assert.equal(result.summary.commission, -55800);
  assert.equal(result.summary.collections, 48200);
  assert.equal(result.summary.expectedRemainingCommission, -32400);
  assert.equal(calculateChitCommissionTrends([{ ...fund, status: 'Completed' }], 6).summary.expectedRemainingCommission, 0);
});

test('weekly loan income includes document charges and excess repayment once', () => {
  const loan = { id: 1, amount: 10000, documentCharge: 500, loanType: 'Flat', repaymentType: 'Weekly',
    interestRate: 0, remainingAmount: 0, disbursementDate: new Date('2026-08-01'),
    repayments: [{ id: 1, amount: 11000, paidDate: new Date('2026-09-01') }],
  };
  assert.equal(calculateLoanProfit(loan, loan.repayments), 1500);
  const total = calculateTotalFinancialMetrics([loan], [fund]);
  assert.equal(total.loanProfit, 1500);
  assert.equal(total.interestPayments, 1000);
  assert.equal(total.documentCharges, 500);
  assert.equal(total.chitFundProfit, -55800);
  assert.equal(total.totalProfit, -54300); // 1,500 − 55,800
});

test('monthly and lifetime commission use the same completed-payout formula', () => {
  const result = calculatePeriodFinancialMetrics([], [fund], [], {
    startDate: new Date('2026-09-01'), endDate: new Date('2026-09-30T23:59:59'),
  });
  assert.equal(result.chitFundProfit, -30400);
});

// Real-world shapes: monthly 4,800, first month 5,000, 10 months → term contribution 48,200.
const FIXED_PLAN = [43000, 43700, 44400, 45200, 46000, 46800, 47600, 48500, 49300, 50000];
const fund50k = {
  monthlyContribution: 4800, firstMonthContribution: 5000, duration: 10, chitFundType: 'Fixed', currentMonth: 10,
};
const payouts = (amounts, months) => amounts.map((amount, i) => ({ amount, month: months ? months[i] : i + 1, date: new Date('2026-01-01') }));

test('scenario: 1-member fund, one payout in month 6', () => {
  const f = { ...fund50k, membersCount: 1, currentMonth: 6 };
  assert.equal(getChitTermContribution(f), 48200);
  assert.equal(calculateChitPayoutCommission(f, { month: 6, amount: 46800 }), 1400);
  assert.equal(calculateChitFundProfitUpToCurrentMonth(f, [], payouts([46800], [6])), 1400);
});

test('scenario: 11 members on a 10-month fund', () => {
  // The fixed plan (464,500) plus a second month-1 payout of 35,800 → 500,300 paid out.
  const auctions = [...payouts(FIXED_PLAN), ...payouts([35800], [1])];
  assert.equal(auctions.reduce((sum, a) => sum + a.amount, 0), 500300);
  // 11 × 48,200 − 500,300 = 530,200 − 500,300
  assert.equal(calculateChitFundProfitUpToCurrentMonth({ ...fund50k, membersCount: 10 }, [], auctions), 29900);
});

test('scenario: 30k fund with 3 members, all paid out', () => {
  const f = { monthlyContribution: 2850, firstMonthContribution: 3000, duration: 10, chitFundType: 'Fixed', currentMonth: 10, membersCount: 10 };
  assert.equal(getChitTermContribution(f), 28650); // 3,000 + 9 × 2,850
  // 3 × 28,650 − (25,500 + 26,000 + 26,600) = 85,950 − 78,100
  assert.equal(calculateChitFundProfit(f, [], payouts([25500, 26000, 26600])), 7850);
});

test('scenario: full 10-member fund, one auction per planned amount', () => {
  // 10 × 48,200 − 464,500 = 482,000 − 464,500
  assert.equal(calculateChitFundProfit({ ...fund50k, membersCount: 10 }, [], payouts(FIXED_PLAN)), 17500);
  const total = calculateTotalFinancialMetrics([], [{ ...fund50k, id: 1, name: 'x', contributions: [], auctions: payouts(FIXED_PLAN) }]);
  assert.equal(total.chitFundProfit, 17500);
});

// Reconciliation: profit = netCash + winnersStillOwe − heldForUnpaid + pendingPayouts, exactly.
const assertReconciles = (r) => {
  assert.equal(r.netCash + r.winnersStillOwe - r.heldForUnpaid + r.pendingPayouts, r.profit);
};
const DAY = 24 * 60 * 60 * 1000;
const past = new Date(Date.now() - 30 * DAY);
const future = new Date(Date.now() + 30 * DAY);

test('reconciliation: 1-member fund (Abi), paid in full, one payout in month 6', () => {
  const f = { ...fund50k, membersCount: 1, currentMonth: 6 };
  const contributions = [5000, ...Array(9).fill(4800)].map(amount => ({ amount, memberId: 1 }));
  const auctions = [{ amount: 46800, month: 6, date: past, winnerId: 1 }];
  const r = calculateChitProfitReconciliation(f, contributions, auctions);
  // 48,200 in − 46,800 out; the winner has paid the full term; nobody else is waiting.
  assert.deepEqual(r, { profit: 1400, netCash: 1400, winnersStillOwe: 0, heldForUnpaid: 0, pendingPayouts: 0 });
  assert.equal(r.profit, calculateChitFundProfitUpToCurrentMonth(f, contributions, auctions));
  assertReconciles(r);
});

// 15 months, monthly 5,800, first month 6,000 → term 6,000 + 14 × 5,800 = 87,200.
const fund15 = { monthlyContribution: 5800, firstMonthContribution: 6000, duration: 15, chitFundType: 'Fixed', currentMonth: 4 };
// 3 members each paid months 1-4: 6,000 + 3 × 5,800 = 23,400 (70,200 in total).
const paid4 = [1, 2, 3].flatMap(memberId => [6000, 5800, 5800, 5800].map(amount => ({ amount, memberId })));

test('reconciliation: running fund mid-term, one winner', () => {
  assert.equal(getChitTermContribution(fund15), 87200);
  const auctions = [{ amount: 75000, month: 2, date: past, winnerId: 1 }];
  const r = calculateChitProfitReconciliation(fund15, paid4, auctions);
  assert.equal(r.netCash, -4800);          // 70,200 − 75,000
  assert.equal(r.winnersStillOwe, 63800);  // 87,200 − 23,400
  assert.equal(r.heldForUnpaid, 46800);    // members 2 and 3: 2 × 23,400
  assert.equal(r.pendingPayouts, 0);
  assert.equal(r.profit, 12200);           // 87,200 − 75,000 = −4,800 + 63,800 − 46,800
  assert.equal(r.profit, calculateChitFundProfitUpToCurrentMonth(fund15, paid4, auctions));
  assertReconciles(r);
});

test('reconciliation: recorded payouts not yet counted, ownerless and over-paid contributions', () => {
  const auctions = [
    { amount: 75000, month: 2, date: past, winnerId: 1 },
    { amount: 76000, month: 4, date: future, winnerId: 2 },  // future date: not counted
    { amount: 77000, month: 5, date: past, winnerId: 3 },    // month 5 > currentMonth 4: not counted
  ];
  const r = calculateChitProfitReconciliation(fund15, paid4, auctions);
  assert.equal(r.netCash, -157800);        // 70,200 − (75,000 + 76,000 + 77,000)
  assert.equal(r.winnersStillOwe, 63800);  // only member 1's win is counted
  assert.equal(r.heldForUnpaid, 46800);    // members 2 and 3 have no counted win yet
  assert.equal(r.pendingPayouts, 153000);  // 76,000 + 77,000
  assert.equal(r.profit, 12200);           // −157,800 + 63,800 − 46,800 + 153,000
  assert.equal(r.profit, calculateChitFundProfitUpToCurrentMonth(fund15, paid4, auctions));
  assertReconciles(r);

  // A contribution without a member is held (no winner), not a crash.
  const ownerless = calculateChitProfitReconciliation(fund15, [...paid4, { amount: 1000, memberId: null }], auctions);
  assert.equal(ownerless.heldForUnpaid, 47800);
  assert.equal(ownerless.netCash, -156800);
  assertReconciles(ownerless);

  // A winner who paid more than the term owes a negative amount; the raw sum keeps the identity.
  const overpaid = calculateChitProfitReconciliation(fund15, [{ amount: 90000, memberId: 1 }], [auctions[0]]);
  assert.equal(overpaid.winnersStillOwe, -2800); // 87,200 − 90,000
  assert.equal(overpaid.netCash, 15000);         // 90,000 − 75,000
  assert.equal(overpaid.profit, 12200);          // 15,000 − 2,800
  assertReconciles(overpaid);
});

test('reconciliation: finished funds reconcile to inflow − outflow', () => {
  // Fund #3 shape: 3 members, all paid the full term (28,650) and all paid out.
  const f = { monthlyContribution: 2850, firstMonthContribution: 3000, duration: 10, chitFundType: 'Fixed', currentMonth: 10 };
  const contributions = [1, 2, 3].map(memberId => ({ amount: 28650, memberId }));
  const auctions = [25500, 26000, 26600].map((amount, i) => ({ amount, month: i + 1, date: past, winnerId: i + 1 }));
  const r = calculateChitProfitReconciliation(f, contributions, auctions);
  assert.deepEqual(r, { profit: 7850, netCash: 7850, winnersStillOwe: 0, heldForUnpaid: 0, pendingPayouts: 0 });
});

// Projection: remaining payouts are members not yet paid out.
const NOW = new Date('2026-10-08');
const won = (winners, months) => winners.map((winnerId, i) => ({ amount: FIXED_PLAN[months[i] - 1], month: months[i], date: new Date('2026-01-01'), winnerId }));
const projected = (f) => calculateChitCommissionTrends([{ contributions: [], auctionBookings: [], status: 'Active', ...f }], 6, NOW).summary.expectedRemainingCommission;
const plan50k = FIXED_PLAN.map((amount, i) => ({ month: i + 1, amount }));

test('projection: every member already paid out → nothing remaining', () => {
  // Fund #3 shape: 10-month fund, 3 members, all won; the 7 unauctioned months are not payouts.
  const f = { monthlyContribution: 2850, firstMonthContribution: 3000, duration: 10, chitFundType: 'Fixed', currentMonth: 10,
    fixedAmounts: [], members: [{ id: 1 }, { id: 2 }, { id: 3 }], // no plan needed when nobody is left
    auctions: [25500, 26000, 26600].map((amount, i) => ({ amount, month: i + 1, date: new Date('2026-01-01'), winnerId: i + 1 })) };
  assert.equal(projected(f), 0);
  // Auction-type funds with nobody left also project 0, not "unknown".
  assert.equal(projected({ ...f, chitFundType: 'Auction', fixedAmounts: [] }), 0);
});

test('projection: booked member uses the booked month, unbooked the next free month', () => {
  const f = { ...fund50k, currentMonth: 3, fixedAmounts: plan50k,
    members: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    auctions: won([1, 2], [1, 2]),
    // Member 1's month-3 booking is stale (they won month 1), so month 3 stays free.
    auctionBookings: [{ memberId: 3, month: 9 }, { memberId: 1, month: 3 }] };
  // Member 3: month 9 (49,300) → 48,200 − 49,300 = −1,100
  // Member 4: next free month 3 (44,400) → 48,200 − 44,400 = 3,800
  assert.equal(projected(f), 2700);
  // A future-dated recorded auction does not count as a win: its winner is still projected.
  assert.equal(projected({ ...f, auctions: [...f.auctions, { amount: 44400, month: 3, date: '2026-11-01', winnerId: 4 }] }), 2700);
});

test('projection: more members than months use the final month amount', () => {
  // 3-month fund (term 14,600), 5 members; members 1-2 won months 1-2; month 3 is the only free month.
  const f = { ...fund, members: [1, 2, 3, 4, 5].map(id => ({ id })) };
  // Member 3 takes month 3 (47,000); members 4 and 5 run out of months → final month 47,000.
  // 3 × (14,600 − 47,000) = −97,200
  assert.equal(projected(f), -97200);
  // No plan row for the final month → fall back to totalAmount (50,000): 14,600 − 50,000 = −35,400.
  const full = { ...fund, currentMonth: 3, totalAmount: 50000, members: [1, 2, 3, 4].map(id => ({ id })),
    fixedAmounts: fund.fixedAmounts.slice(0, 2),
    auctions: [...fund.auctions, { month: 3, amount: 47000, date: new Date('2026-09-20'), winnerId: 3 }] };
  assert.equal(projected(full), -35400);
  // ...and without totalAmount the projection is unknown.
  assert.equal(projected({ ...full, totalAmount: null }), null);
});

test('projection: Auction-type fund with no plan is unknown', () => {
  assert.equal(projected({ ...fund, chitFundType: 'Auction', fixedAmounts: [] }), null);
  // A Fixed fund missing the plan row a remaining member needs is unknown too.
  assert.equal(projected({ ...fund, fixedAmounts: fund.fixedAmounts.slice(0, 2) }), null);
});

test('loan return excludes chit earnings; zero/negative capital is unavailable', () => {
  const html = renderToStaticMarkup(React.createElement(LoanReturn, { loanProfit: 3000, investedAmount: 100000 }));
  assert.match(html, /3\.0%/);
  assert.doesNotMatch(html, /23\.0%/);
  for (const investedAmount of [0, -100]) {
    const unavailable = renderToStaticMarkup(React.createElement(LoanReturn, { loanProfit: 3000, investedAmount }));
    assert.match(unavailable, /—/);
    assert.doesNotMatch(unavailable, /Infinity|NaN/);
  }
  const combined = renderToStaticMarkup(React.createElement(BusinessEarnings, { loanProfit: 3000, chitFundProfit: 20000, investedAmount: 100000 }));
  assert.match(combined, /23,000/);
  assert.doesNotMatch(combined, /Overall ROI|Active Book Yield|Profit Margin/);
  const capital = renderToStaticMarkup(React.createElement(CapitalPosition, { loanOutstanding: 120000, investedAmount: 100000 }));
  assert.match(capital, /1\.20x/);
  assert.doesNotMatch(capital, /Capital Rotating|Available Buffer|Capital Multiplying/);
});

test('commission API enforces authentication and month bounds and only reads owner records', async () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  let currentUserId = null;
  const queries = [];
  let GET;
  try {
    Module._load = function(request, parent, isMain) {
      if (request.endsWith('/lib/auth')) return { getCurrentUserId: async () => currentUserId };
      if (request.endsWith('/lib/prisma')) return { __esModule: true, default: {
        chitFund: { findMany: async query => { queries.push(query); return [fund]; } },
      } };
      return originalLoad.call(this, request, parent, isMain);
    };
    GET = require('../app/api/chit-funds/monthly-profit/route').GET;
  } finally { Module._load = originalLoad; }
  const request = months => new Request(`http://localhost/api/chit-funds/monthly-profit?months=${months}`);
  assert.equal((await GET(request('6'))).status, 401);
  assert.equal(queries.length, 0);
  currentUserId = 42;
  for (const months of ['0', '-1', '25', 'abc', '1.5']) {
    assert.equal((await GET(request(months))).status, 400);
  }
  assert.equal(queries.length, 0);
  const response = await GET(request('6'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).months.length, 6);
  assert.deepEqual(queries[0].where, { createdById: 42 });
  // The mock exposes findMany only: any attempted create/update/delete fails this test.
});
