// Run with: node tests/trends-calculations.js. No database connection or writes.
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', jsx: 'react-jsx' });
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { calculateChitPayoutCommission, calculateChitCommissionTrends, getChitTermContribution } = require('../lib/chitCommission');
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
    { id: 1, month: 1, amount: 40000, date: new Date('2026-08-15') },
    { id: 2, month: 2, amount: 45000, date: new Date('2026-09-15') },
  ],
  contributions: [{ id: 1, month: 1, amount: 48200, paidDate: new Date('2026-08-10') }],
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
    auctions: [...fund.auctions, { month: 3, amount: 47000, date: '2026-11-01' }],
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
