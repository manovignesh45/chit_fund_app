// Run with: node tests/test-itr-report.js. No database connection or writes.
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', jsx: 'react-jsx' });
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');

// lib/balanceCalculator.ts loads the Prisma client at import; stub it so only the pure rule is used.
const prismaPath = require.resolve('../lib/prisma');
const stub = new Module(prismaPath);
stub.filename = prismaPath;
stub.loaded = true;
stub.exports = { default: {} };
require.cache[prismaPath] = stub;
const { calculateTransactionBalance } = require('../lib/balanceCalculator');

const fp = require('../lib/fiscalPeriods');
const { buildItrReport } = require('../lib/itrReport');
const { calculateLoanProfit } = require('../lib/financialUtils');
const { LEDGER_TYPE_EFFECT } = require('../lib/amountFlowTally');
const cat = require('../lib/recordAmountCategories');

const paise = (n) => Math.round(n * 100);
const AS_OF = new Date('2026-11-17T10:00:00Z');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const partners = [{ id: 1, name: 'Ravi' }, { id: 2, name: 'Kumar' }];
const winner = (name) => ({ globalMember: { name } });

// Term contribution 4,000 + 9 × 5,000 = 49,000 (month 1 uses the first-month contribution).
const chitFunds = [{
  id: 1, name: 'Gold 1L', monthlyContribution: 5000, firstMonthContribution: 4000, duration: 10, chitFundType: 'Fixed',
  auctions: [
    { id: 11, month: 1, amount: 40000, date: '2025-05-10T00:00:00Z', winner: winner('Asha') }, // 9,000
    { id: 12, month: 2, amount: 42000, date: '2025-10-10T00:00:00Z', winner: winner('Bala') }, // 7,000
    { id: 13, month: 3, amount: 45000, date: '2026-03-31T00:00:00Z', winner: winner('Chitra') }, // 4,000, FY 2025-26
    { id: 14, month: 4, amount: 46000, date: '2026-04-01T00:00:00Z', winner: winner('Devi') }, // 3,000, FY 2026-27
    { id: 15, month: 5, amount: 47000, date: '2026-12-10T00:00:00Z', winner: winner('Elan') }, // after asOf
  ],
}];

const monthly = (id, from, count, amount, extra = {}) => Array.from({ length: count }, (_, i) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + i);
  return { id: id * 100 + i + 1, amount, paidDate: d.toISOString(), period: i + 1, paymentType: 'full', ...extra };
});
const weekly = (id, dates, amount) => dates.map((date, i) => ({ id: id * 100 + i + 1, amount, paidDate: date, period: i + 1, paymentType: 'full' }));

const loans = [
  // Monthly: 500 interest per repayment, document charge 300 on 5 Apr 2025.
  { id: 1, borrower: { name: 'Mani' }, amount: 10000, interestRate: 500, documentCharge: 300, repaymentType: 'Monthly', loanType: 'Monthly',
    disbursementDate: '2025-04-05T00:00:00Z', status: 'Active', remainingAmount: 0, repayments: monthly(1, '2025-05-05T00:00:00Z', 12, 1333) },
  // Weekly: 4 × 1,200 before 1 Apr 2026 (principal not covered), 2 more after: interest 2,200 in FY 2026-27.
  { id: 2, borrower: { name: 'Nila' }, amount: 5000, interestRate: 0, documentCharge: 0, repaymentType: 'Weekly', loanType: 'Weekly',
    disbursementDate: '2026-03-01T00:00:00Z', status: 'Completed', remainingAmount: 0,
    repayments: weekly(2, ['2026-03-08', '2026-03-15', '2026-03-22', '2026-03-29', '2026-04-05', '2026-04-12'].map((d) => `${d}T00:00:00Z`), 1200) },
  // Reducing Balance, 12% a year: interest 120, 101.20, 82.212.
  { id: 3, borrower: { name: 'Oviya' }, amount: 12000, interestRate: 0, interestPercentage: 12, documentCharge: 0, repaymentType: 'Monthly', loanType: 'Reducing Balance',
    disbursementDate: '2025-07-01T00:00:00Z', status: 'Active', remainingAmount: 6303.41, repayments: monthly(3, '2025-08-01T00:00:00Z', 3, 2000) },
  // Monthly, marked Non-Recoverable 7 Nov 2026 with 20,000 principal; 5,000 + 200 interest recovered 10 Nov (IST).
  { id: 4, borrower: { name: 'Prabhu' }, amount: 20000, interestRate: 1000, documentCharge: 0, repaymentType: 'Monthly', loanType: 'Monthly',
    disbursementDate: '2026-05-01T00:00:00Z', status: 'Non-Recoverable', nonRecoverableAt: '2026-11-07T10:15:00Z', recoveryPrincipalAtMark: 20000, remainingAmount: 15000,
    repayments: [...monthly(4, '2026-06-01T00:00:00Z', 3, 1000),
      { id: 401, amount: 5200, paidDate: '2026-11-09T18:30:00Z', period: 0, paymentType: 'RECOVERY', principalComponent: 5000, interestComponent: 200 }] },
  // Marked, then restored: no write-off, and its recovery receipt is an ordinary principal repayment.
  { id: 5, borrower: { name: 'Ramya' }, amount: 8000, interestRate: 400, documentCharge: 0, repaymentType: 'Monthly', loanType: 'Monthly',
    disbursementDate: '2026-04-10T00:00:00Z', status: 'Active', nonRecoverableAt: '2026-06-01T09:00:00Z', recoveryPrincipalAtMark: 8000, remainingAmount: 6000,
    repayments: [{ id: 501, amount: 1000, paidDate: '2026-06-14T18:30:00Z', period: 0, paymentType: 'RECOVERY', principalComponent: 1000, interestComponent: 0 },
      { id: 502, amount: 1400, paidDate: '2026-07-10T00:00:00Z', period: 1, paymentType: 'full' }] },
  // Weekly, 5 × 1,100 paid, marked with 5,000 principal (period-based), 5,000 recovered.
  { id: 6, borrower: { name: 'Selvi' }, amount: 10000, interestRate: 0, documentCharge: 0, repaymentType: 'Weekly', loanType: 'Weekly',
    disbursementDate: '2025-12-01T00:00:00Z', status: 'Non-Recoverable', nonRecoverableAt: '2026-02-20T06:00:00Z', recoveryPrincipalAtMark: 5000, remainingAmount: 0,
    repayments: [...weekly(6, ['2025-12-08', '2025-12-15', '2025-12-22', '2025-12-29', '2026-01-05'].map((d) => `${d}T00:00:00Z`), 1100),
      { id: 601, amount: 5000, paidDate: '2026-03-09T18:30:00Z', period: 0, paymentType: 'RECOVERY', principalComponent: 5000, interestComponent: 0 }] },
];

const tx = (id, type, date, amount, extra = {}) => ({ id, type, date, amount, note: null, category: null, from_partner_id: null, to_partner_id: null, ...extra });
const credit = (id, date, amount, category, note, partner) => tx(id, 'RECORD_AMOUNT', date, amount, { category, note, to_partner_id: partner });
const debit = (id, date, amount, category, note, partner) => tx(id, 'RECORD_AMOUNT', date, amount, { category, note, from_partner_id: partner });
const D = (d) => `${d}T00:00:00Z`;

const transactions = [
  // FY 2024-25: older lower-case types only.
  tx(1, 'loan_given', D('2024-11-01'), 10000, { from_partner_id: 1 }),
  tx(2, 'loan_repaid', D('2024-12-01'), 500, { to_partner_id: 1 }),
  tx(3, 'collection', D('2025-01-15'), 300, { to_partner_id: 2 }),
  // FY 2025-26
  tx(10, 'LOAN_DISBURSEMENT', D('2025-04-05'), 9700, { from_partner_id: 1 }),
  tx(11, 'DOCUMENT_CHARGE', D('2025-04-05'), 300, { to_partner_id: 1 }),
  tx(12, 'CHIT_CONTRIBUTION', D('2025-05-01'), 4000, { to_partner_id: 1 }),
  tx(13, 'AUCTION_PAYOUT', D('2025-05-10'), 40000, { from_partner_id: 2 }),
  credit(14, D('2025-06-30'), 100000, 'OPENING_BALANCE', 'old amount reset', 1),
  credit(15, D('2025-06-30'), 50000, null, 'tally old remaining balance', 2),
  tx(16, 'PARTNER_TO_PARTNER', D('2025-07-15'), 20000, { from_partner_id: 1, to_partner_id: 2 }),
  tx(17, 'CHIT_CONTRIBUTION', D('2025-08-01'), 1000), // no partner: Unassigned
  credit(18, D('2025-11-01'), 10000.33, 'CAPITAL_IN', 'capital investment', 1),
  debit(19, D('2025-12-20'), 1200, 'EXPENSE', 'Office / operating expense', 1),
  debit(20, D('2026-01-10'), 5000, 'DRAWINGS', 'capital withdrawal', 2),
  credit(21, D('2026-02-01'), 10, 'CORRECTION', 'balance correction', 1),
  debit(22, D('2026-02-01'), 20, 'CORRECTION', 'balance correction', 2),
  credit(23, D('2026-02-15'), 700, 'EXPENSE', 'refund', 2), // EXPENSE does not allow a credit: unclassified
  tx(24, 'CHIT_CONTRIBUTION', '2026-03-31T17:00:00Z', 5000, { to_partner_id: 1 }), // 31 Mar 22:30 IST
  debit(25, D('2026-03-20'), 800, null, 'food for meeting', 1),
  tx(26, 'transfer', D('2026-03-25'), 3000, { from_partner_id: 2, to_partner_id: 1 }),
  // FY 2026-27
  tx(30, 'CHIT_CONTRIBUTION', '2026-03-31T18:45:00Z', 5000, { to_partner_id: 2 }), // 1 Apr 00:15 IST
  tx(31, 'AUCTION_PAYOUT', D('2026-04-01'), 46000, { from_partner_id: 1 }),
  debit(32, D('2026-06-12'), 45000, 'ADVANCE_GIVEN', 'car', 1),
  credit(33, D('2026-06-15'), 2400, 'OTHER_INCOME', 'car rent', 2),
  tx(38, 'PARTNER_TO_PARTNER', D('2026-08-01'), 1000, { from_partner_id: 2, to_partner_id: 1 }),
  tx(39, 'mystery', D('2026-08-01'), 777, { to_partner_id: 1 }), // unknown type: no effect
  credit(34, D('2026-09-01'), 5000, 'ADVANCE_RETURNED', 'advance returned', 1),
  debit(36, D('2026-10-05'), 2000, 'EXPENSE', 'party', 2),
  tx(35, 'LOAN_REPAYMENT', '2026-11-09T18:30:00Z', 5200, { to_partner_id: 1 }),
  tx(40, 'CHIT_CONTRIBUTION', D('2026-11-17'), 100, { to_partner_id: 1 }), // asOf day: included
  tx(41, 'CHIT_CONTRIBUTION', D('2026-11-18'), 200, { to_partner_id: 1 }), // 18 Nov 05:30 IST: after asOf
  tx(37, 'CHIT_CONTRIBUTION', D('2026-12-01'), 9999, { to_partner_id: 1 }), // future
];

const input = { transactions, loans, chitFunds, partners };
const build = (fy, period, scope = 'all', asOf = AS_OF, data = input) => buildItrReport(data, { fy, period, scope, asOf });

const pl = (r, key) => [...r.profitAndLoss.income, ...r.profitAndLoss.expenses].find((l) => l.key === key);
const cash = (r, key) => [...r.cashFlow.receipts, ...r.cashFlow.payments].find((l) => l.key === key);

/** Every line and total of a report, by key, in paise. */
function figures(r) {
  const out = {};
  for (const l of [...r.profitAndLoss.income, ...r.profitAndLoss.expenses]) out[`pl:${l.key}`] = paise(l.total);
  for (const l of [...r.cashFlow.receipts, ...r.cashFlow.payments]) out[`cash:${l.key}`] = paise(l.total);
  for (const k of ['totalIncome', 'totalExpenses', 'netProfit']) out[k] = paise(r.profitAndLoss[k].total);
  for (const k of ['totalReceipts', 'totalPayments', 'netMovement']) out[k] = paise(r.cashFlow[k].total);
  if (r.cashFlow.transfers) out.transfers = paise(r.cashFlow.transfers.total);
  return out;
}

function assertParts(parts, whole, label) {
  const w = figures(whole);
  const sums = {};
  for (const part of parts) for (const [k, v] of Object.entries(figures(part))) sums[k] = (sums[k] || 0) + v;
  assert.deepEqual(Object.keys(sums).sort(), Object.keys(w).sort(), `${label}: same lines`);
  for (const k of Object.keys(w)) assert.equal(sums[k], w[k], `${label}: ${k}`);
  // The month columns line up as well: the parts' months, in order, are the whole's months.
  assert.deepEqual(parts.flatMap((p) => p.months.map((m) => m.key)), whole.months.map((m) => m.key), `${label}: months`);
  assert.deepEqual(parts.flatMap((p) => p.profitAndLoss.netProfit.months), whole.profitAndLoss.netProfit.months, `${label}: net profit months`);
}

function assertMonthsSum(r, label) {
  const series = [
    ...r.profitAndLoss.income, ...r.profitAndLoss.expenses, ...r.cashFlow.receipts, ...r.cashFlow.payments,
    r.profitAndLoss.totalIncome, r.profitAndLoss.totalExpenses, r.profitAndLoss.netProfit,
    r.cashFlow.totalReceipts, r.cashFlow.totalPayments, r.cashFlow.netMovement,
    ...(r.cashFlow.transfers ? [r.cashFlow.transfers] : []),
  ];
  for (const s of series) {
    assert.equal(s.months.length, r.months.length, `${label}: ${s.key || 'total'} month count`);
    assert.equal(s.months.reduce((a, m) => a + paise(m), 0), paise(s.total), `${label}: ${s.key || 'total'} months sum`);
  }
  for (const l of [...r.profitAndLoss.income, ...r.profitAndLoss.expenses, ...r.cashFlow.receipts, ...r.cashFlow.payments]) {
    assert.equal(l.records.reduce((a, rec) => a + paise(rec.amount), 0), paise(l.total), `${label}: ${l.key} records sum`);
  }
}

const FYS = [2024, 2025, 2026];
const PERIODS = ['FY', 'H1', 'H2', 'Q1', 'Q2', 'Q3', 'Q4'];

// ---------------------------------------------------------------------------
// fiscalPeriods
// ---------------------------------------------------------------------------

test('31 Mar / 1 Apr IST boundary for 00:00Z and timed rows', () => {
  assert.equal(fp.fiscalYearOf('2026-03-31T00:00:00Z'), 2025);
  assert.equal(fp.fiscalYearOf('2026-04-01T00:00:00Z'), 2026);
  assert.equal(fp.fiscalYearOf('2026-03-31T18:29:59.999Z'), 2025); // 31 Mar 23:59 IST
  assert.equal(fp.fiscalYearOf('2026-03-31T18:30:00Z'), 2026); // 1 Apr 00:00 IST
  assert.equal(fp.fiscalYearOf('2026-03-31T17:00:00Z'), 2025);
  assert.equal(fp.fiscalYearOf('2026-03-31T18:45:00Z'), 2026);
  const fy = fp.fiscalPeriodRange(2025, 'FY');
  assert.equal(fy.start.toISOString(), '2025-03-31T18:30:00.000Z');
  assert.equal(fy.endExclusive.toISOString(), '2026-03-31T18:30:00.000Z');
  assert.equal(fp.istDayKey('2026-03-31T18:45:00Z'), '2026-04-01');
  assert.equal(fp.istNextDayStart(AS_OF).toISOString(), '2026-11-17T18:30:00.000Z');

  // In the report: the 17:00Z contribution is FY 2025-26 (March), the 18:45Z one FY 2026-27 (April).
  const fy25 = build(2025, 'FY');
  const fy26 = build(2026, 'FY');
  assert.ok(cash(fy25, 'chitContributions').records.some((r) => r.id === 24));
  assert.ok(!cash(fy25, 'chitContributions').records.some((r) => r.id === 30));
  assert.ok(cash(fy26, 'chitContributions').records.some((r) => r.id === 30));
  assert.equal(cash(fy25, 'chitContributions').months[11], 5000);
  assert.equal(cash(fy26, 'chitContributions').months[0], 5000);
  // Auctions stored 31 Mar 00:00Z and 1 Apr 00:00Z fall either side.
  assert.ok(pl(fy25, 'chitMargin').records.some((r) => r.id === 13));
  assert.ok(pl(fy26, 'chitMargin').records.some((r) => r.id === 14));
});

test('ranges, month buckets, labels and parsing', () => {
  const q4 = fp.fiscalPeriodRange(2025, 'Q4');
  assert.equal(q4.start.toISOString(), '2025-12-31T18:30:00.000Z');
  assert.equal(q4.endExclusive.toISOString(), '2026-03-31T18:30:00.000Z');
  const months = fp.monthBuckets(fp.fiscalPeriodRange(2025, 'FY'));
  assert.equal(months.length, 12);
  assert.deepEqual([months[0].key, months[0].label, months[11].key, months[11].label], ['2025-04', 'Apr 2025', '2026-03', 'Mar 2026']);
  for (let i = 1; i < months.length; i++) assert.equal(months[i].start.getTime(), months[i - 1].endExclusive.getTime());
  assert.equal(months[1].start.toISOString(), '2025-04-30T18:30:00.000Z');
  assert.deepEqual(fp.monthBuckets({ start: q4.start, endExclusive: q4.start }), []);

  assert.equal(fp.fiscalYearLabel(2025), 'FY 2025-26');
  assert.equal(fp.fiscalYearLabel(1999), 'FY 1999-00');
  assert.equal(fp.fiscalPeriodLabel(2025, 'FY'), 'FY 2025-26');
  assert.equal(fp.fiscalPeriodLabel(2025, 'Q1'), 'Q1 (Apr–Jun 2025)');
  assert.equal(fp.fiscalPeriodLabel(2025, 'Q3'), 'Q3 (Oct–Dec 2025)');
  assert.equal(fp.fiscalPeriodLabel(2025, 'Q4'), 'Q4 (Jan–Mar 2026)');
  assert.equal(fp.fiscalPeriodLabel(2025, 'H1'), 'H1 (Apr–Sep 2025)');
  assert.equal(fp.fiscalPeriodLabel(2025, 'H2'), 'H2 (Oct 2025–Mar 2026)');
  assert.equal(fp.filingYearLabel(2024), 'AY 2025-26');
  assert.equal(fp.filingYearLabel(2025), 'AY 2026-27');
  assert.equal(fp.filingYearLabel(2026), 'Tax Year 2026-27');

  assert.equal(fp.parseFiscalYear('2025'), 2025);
  assert.equal(fp.parseFiscalYear(2025), 2025);
  for (const bad of ['25', '2025-26', 'abc', '', null, undefined, '1999', 2025.5]) assert.equal(fp.parseFiscalYear(bad), null, String(bad));
  assert.equal(fp.parseFiscalPeriod('q2'), 'Q2');
  assert.equal(fp.parseFiscalPeriod('FY'), 'FY');
  for (const bad of ['Q5', 'year', '', null, 3]) assert.equal(fp.parseFiscalPeriod(bad), null, String(bad));
});

test('fiscal year listing and period status', () => {
  assert.deepEqual(fp.listFiscalYears('2024-11-01T00:00:00Z', AS_OF), [2024, 2025, 2026]);
  assert.deepEqual(fp.listFiscalYears(new Date('2025-03-31T17:00:00Z'), AS_OF), [2024, 2025, 2026]);
  assert.deepEqual(fp.listFiscalYears('2025-03-31T18:30:00Z', AS_OF), [2025, 2026]);
  assert.deepEqual(fp.listFiscalYears(null, AS_OF), [2026]);
  assert.deepEqual(fp.listFiscalYears('2030-01-01T00:00:00Z', AS_OF), [2026]);

  assert.equal(fp.fiscalPeriodStatus(fp.fiscalPeriodRange(2025, 'FY'), AS_OF), 'complete');
  assert.equal(fp.fiscalPeriodStatus(fp.fiscalPeriodRange(2026, 'FY'), AS_OF), 'running');
  assert.equal(fp.fiscalPeriodStatus(fp.fiscalPeriodRange(2026, 'Q3'), AS_OF), 'running');
  assert.equal(fp.fiscalPeriodStatus(fp.fiscalPeriodRange(2026, 'Q4'), AS_OF), 'not-started');
  const clamped = fp.clampRangeToAsOf(fp.fiscalPeriodRange(2026, 'FY'), AS_OF);
  assert.equal(clamped.endExclusive.toISOString(), '2026-11-17T18:30:00.000Z');
  const empty = fp.clampRangeToAsOf(fp.fiscalPeriodRange(2026, 'Q4'), AS_OF);
  assert.equal(empty.endExclusive.getTime(), empty.start.getTime());
});

// ---------------------------------------------------------------------------
// Additivity and cash identities
// ---------------------------------------------------------------------------

test('Q1+Q2 = H1, Q3+Q4 = H2, H1+H2 = FY for every line, in every scope; months sum to totals', () => {
  for (const scope of ['all', 'chits', 'loans']) {
    for (const fy of FYS) {
      const r = Object.fromEntries(PERIODS.map((p) => [p, build(fy, p, scope)]));
      for (const p of PERIODS) assertMonthsSum(r[p], `${scope} ${fy} ${p}`);
      assertParts([r.Q1, r.Q2], r.H1, `${scope} ${fy} Q1+Q2`);
      assertParts([r.Q3, r.Q4], r.H2, `${scope} ${fy} Q3+Q4`);
      assertParts([r.H1, r.H2], r.FY, `${scope} ${fy} H1+H2`);
      assertParts([r.Q1, r.Q2, r.Q3, r.Q4], r.FY, `${scope} ${fy} quarters`);
    }
  }
});

test('opening + net = closing; next period opens at this closing; partner rows add up to the total', () => {
  const chain = [];
  for (const fy of FYS) for (const p of ['Q1', 'Q2', 'Q3', 'Q4']) chain.push(build(fy, p));
  for (const fy of FYS) chain.push(build(fy, 'FY'));
  for (const r of chain) {
    const cf = r.cashFlow;
    assert.equal(paise(cf.opening) + paise(cf.netMovement.total), paise(cf.closing), r.period.label);
    assert.equal(cf.partners.reduce((a, p) => a + paise(p.opening), 0), paise(cf.opening), `${r.period.label} partner opening`);
    assert.equal(cf.partners.reduce((a, p) => a + paise(p.closing), 0), paise(cf.closing), `${r.period.label} partner closing`);
    for (const p of cf.partners) {
      assert.equal(paise(p.opening) + paise(p.in) - paise(p.out) + paise(p.transfersIn) - paise(p.transfersOut), paise(p.closing), `${r.period.label} ${p.name}`);
    }
    assert.equal(cf.closingByMonth.length ? paise(cf.closingByMonth.at(-1)) : paise(cf.opening), paise(cf.closing));
  }
  for (let i = 1; i < FYS.length * 4; i++) {
    assert.equal(paise(chain[i].cashFlow.opening), paise(chain[i - 1].cashFlow.closing), `${chain[i].period.label} opening`);
  }
  assert.equal(build(2025, 'FY').cashFlow.opening, build(2024, 'FY').cashFlow.closing);
  assert.equal(build(2026, 'FY').cashFlow.opening, build(2025, 'FY').cashFlow.closing);
});

test('cash flow FY 2025-26 by line, with partner balances', () => {
  const r = build(2025, 'FY');
  const cf = r.cashFlow;
  assert.equal(cf.pooled, false);
  assert.equal(cf.opening, -9200);
  const expected = {
    chitContributions: 10000, loanRepayments: 0, documentCharges: 300,
    'record:OPENING_BALANCE:in': 100000, 'record:CAPITAL_IN:in': 10000.33, 'record:OTHER_INCOME:in': 0,
    'record:ADVANCE_RETURNED:in': 0, 'record:CORRECTION:in': 10, 'record:UNCLASSIFIED:in': 50700,
    'other:collection': 0,
    auctionPayouts: 40000, loanDisbursements: 9700, 'record:DRAWINGS:out': 5000, 'record:EXPENSE:out': 1200,
    'record:ADVANCE_GIVEN:out': 0, 'record:CORRECTION:out': 20, 'record:UNCLASSIFIED:out': 800,
  };
  for (const [key, total] of Object.entries(expected)) assert.equal(cash(r, key).total, total, key);
  assert.deepEqual(cf.receipts.map((l) => l.key), [
    'chitContributions', 'loanRepayments', 'documentCharges', 'record:OPENING_BALANCE:in', 'record:CAPITAL_IN:in',
    'record:OTHER_INCOME:in', 'record:ADVANCE_RETURNED:in', 'record:CORRECTION:in', 'record:UNCLASSIFIED:in', 'other:collection',
  ]);
  assert.deepEqual(cf.payments.map((l) => l.key), [
    'auctionPayouts', 'loanDisbursements', 'record:DRAWINGS:out', 'record:EXPENSE:out', 'record:ADVANCE_GIVEN:out',
    'record:CORRECTION:out', 'record:UNCLASSIFIED:out',
  ]);
  assert.equal(cash(r, 'record:UNCLASSIFIED:in').label, 'Unclassified (credit)');
  assert.equal(cash(r, 'record:UNCLASSIFIED:out').label, 'Unclassified (debit)');
  assert.equal(cash(r, 'record:OPENING_BALANCE:in').label, 'Opening balance brought in');
  assert.equal(cf.totalReceipts.total, 171010.33);
  assert.equal(cf.totalPayments.total, 56720);
  assert.equal(cf.netMovement.total, 114290.33);
  assert.equal(cf.closing, 105090.33);
  assert.equal(cf.transfers.total, 23000);
  const byName = Object.fromEntries(cf.partners.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName), ['Ravi', 'Kumar', 'Unassigned']);
  assert.deepEqual(byName.Ravi, { partnerId: 1, name: 'Ravi', opening: -9500, in: 119310.33, out: 11700, transfersIn: 3000, transfersOut: 20000, closing: 81110.33 });
  assert.deepEqual(byName.Kumar, { partnerId: 2, name: 'Kumar', opening: 300, in: 50700, out: 45020, transfersIn: 20000, transfersOut: 3000, closing: 22980 });
  assert.deepEqual(byName.Unassigned, { partnerId: null, name: 'Unassigned', opening: 0, in: 1000, out: 0, transfersIn: 0, transfersOut: 0, closing: 1000 });
});

test('FY 2024-25 closes negative with only older ledger types and warns', () => {
  const r = build(2024, 'FY');
  assert.equal(r.cashFlow.opening, 0);
  assert.equal(r.cashFlow.closing, -9200);
  assert.equal(cash(r, 'loanDisbursements').total, 10000);
  assert.equal(cash(r, 'loanRepayments').total, 500);
  assert.equal(cash(r, 'other:collection').label, 'Collections (older entries)');
  assert.equal(cash(r, 'other:collection').total, 300);
  assert.ok(r.warnings.some((w) => w.code === 'NEGATIVE_CLOSING_CASH' && w.amount === -9200));
  assert.ok(!r.warnings.some((w) => w.code === 'NEGATIVE_OPENING_CASH'));
  assert.ok(build(2025, 'Q1').warnings.some((w) => w.code === 'NEGATIVE_OPENING_CASH'));
});

test('partner transfers cancel in the total but move partner balances', () => {
  const noTransfers = { ...input, transactions: transactions.filter((t) => !['PARTNER_TO_PARTNER', 'transfer'].includes(t.type)) };
  const withT = build(2025, 'FY');
  const without = build(2025, 'FY', 'all', AS_OF, noTransfers);
  assert.equal(withT.cashFlow.netMovement.total, without.cashFlow.netMovement.total);
  assert.equal(withT.cashFlow.closing, without.cashFlow.closing);
  assert.equal(without.cashFlow.transfers.total, 0);
  const ravi = (r) => r.cashFlow.partners.find((p) => p.partnerId === 1).closing;
  const kumar = (r) => r.cashFlow.partners.find((p) => p.partnerId === 2).closing;
  assert.equal(paise(ravi(withT)) - paise(ravi(without)), paise(-20000 + 3000));
  assert.equal(paise(kumar(withT)) - paise(kumar(without)), paise(20000 - 3000));
  // A transfer with one side missing is balanced by Unassigned, so partners still add up.
  const oneSided = build(2025, 'FY', 'all', AS_OF, { ...input, transactions: [tx(1, 'PARTNER_TO_PARTNER', D('2025-07-01'), 500, { to_partner_id: 1 })] });
  assert.equal(oneSided.cashFlow.closing, 0);
  assert.deepEqual(oneSided.cashFlow.partners.map((p) => [p.name, p.closing]), [['Ravi', 500], ['Kumar', 0], ['Unassigned', -500]]);
});

test('ledger effects agree with LEDGER_TYPE_EFFECT and calculateTransactionBalance', () => {
  const types = Object.keys(LEDGER_TYPE_EFFECT);
  const rows = [
    ...types.map((type, i) => tx(i + 1, type, D('2025-05-01'), 1000, { from_partner_id: 1, to_partner_id: 2 })),
    ...types.map((type, i) => tx(i + 101, type, D('2025-05-01'), 1000, { to_partner_id: 2 })),
    ...types.map((type, i) => tx(i + 201, type, D('2025-05-01'), 1000, { from_partner_id: 1 })),
    credit(301, D('2025-05-01'), 1000, 'CAPITAL_IN', '', 2),
    debit(302, D('2025-05-01'), 1000, 'DRAWINGS', '', 1),
    tx(303, 'UNKNOWN_TYPE', D('2025-05-01'), 1000, { to_partner_id: 2 }),
  ];
  for (const row of rows) {
    const r = build(2025, 'FY', 'all', AS_OF, { transactions: [row], loans: [], chitFunds: [], partners });
    const primary = row.to_partner_id || row.from_partner_id;
    const expectedTotal = calculateTransactionBalance(row, primary, 0, 0).totalBalance;
    assert.equal(r.cashFlow.netMovement.total, expectedTotal, `${row.type} #${row.id} total`);
    if (row.type in LEDGER_TYPE_EFFECT) assert.equal(r.cashFlow.netMovement.total, LEDGER_TYPE_EFFECT[row.type] * 1000, `${row.type} effect`);
    for (const p of partners) {
      const expected = calculateTransactionBalance(row, p.id, 0, 0).partnerBalance;
      assert.equal(r.cashFlow.partners.find((x) => x.partnerId === p.id).closing, expected, `${row.type} #${row.id} partner ${p.id}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Profit & loss
// ---------------------------------------------------------------------------

test('P&L FY 2025-26: every line, net profit and partner share', () => {
  const r = build(2025, 'FY');
  assert.deepEqual(r.profitAndLoss.income.map((l) => [l.key, l.total]), [
    ['chitMargin', 20000],
    ['loanInterest:monthly', 5500],
    ['loanInterest:weekly', 0],
    ['loanInterest:reducingBalance', 303.41],
    ['documentCharges', 300],
    ['otherIncome', 0],
    ['badDebtRecovered', 5000],
  ]);
  assert.deepEqual(r.profitAndLoss.expenses.map((l) => [l.key, l.total]), [['expenses', 1200], ['badDebtWrittenOff', 5000]]);
  assert.equal(r.profitAndLoss.totalIncome.total, 31103.41);
  assert.equal(r.profitAndLoss.totalExpenses.total, 6200);
  assert.equal(r.profitAndLoss.netProfit.total, 24903.41);
  // Odd paisa: 24,903.41 / 2, the extra paisa to the first partner.
  assert.deepEqual(r.partnerShare, { netProfit: 24903.41, partners: [{ partnerId: 1, name: 'Ravi', share: 12451.71 }, { partnerId: 2, name: 'Kumar', share: 12451.7 }] });
  assert.equal(r.sharedItemsAllocated, true);
  assert.deepEqual(r.notes, []);
});

test('partner shares add up to net profit, including negative and odd-paisa profit', () => {
  for (const [rows, expected] of [
    [[credit(1, D('2025-05-01'), 100.01, 'OTHER_INCOME', 'rent', 1)], [50.01, 50]],
    [[debit(1, D('2025-05-01'), 100.01, 'EXPENSE', 'food', 1)], [-50.01, -50]],
    [[credit(1, D('2025-05-01'), 0.03, 'OTHER_INCOME', 'rent', 1)], [0.02, 0.01]],
  ]) {
    const r = build(2025, 'FY', 'all', AS_OF, { transactions: rows, loans: [], chitFunds: [], partners });
    assert.deepEqual(r.partnerShare.partners.map((p) => p.share), expected);
    assert.equal(r.partnerShare.partners.reduce((a, p) => a + paise(p.share), 0), paise(r.profitAndLoss.netProfit.total));
  }
  const three = build(2025, 'FY', 'all', AS_OF, { transactions: [credit(1, D('2025-05-01'), 100, 'OTHER_INCOME', 'rent', 1)], loans: [], chitFunds: [], partners: [...partners, { id: 3, name: 'Third' }] });
  assert.deepEqual(three.partnerShare.partners.map((p) => p.share), [33.34, 33.33, 33.33]);
});

test('chit margin lands in the payout period and uses the first-month contribution', () => {
  const q1 = build(2025, 'Q1');
  const margin = pl(q1, 'chitMargin');
  assert.equal(margin.total, 9000);
  assert.deepEqual(margin.months, [0, 9000, 0]); // May
  assert.deepEqual(margin.records, [{
    kind: 'chitPayout', id: 11, date: '2025-05-10T00:00:00.000Z', amount: 9000, description: 'Gold 1L · month 1 · Asha',
    fundId: 1, fundName: 'Gold 1L', member: 'Asha', month: 1, termContribution: 49000, payout: 40000,
  }]);
  assert.equal(pl(build(2025, 'Q3'), 'chitMargin').total, 7000);
  assert.equal(pl(build(2025, 'Q4'), 'chitMargin').total, 4000);
  assert.equal(pl(build(2026, 'Q1'), 'chitMargin').total, 3000);
  // The December 2026 payout is after asOf: not counted, even for the full year.
  assert.equal(pl(build(2026, 'FY'), 'chitMargin').total, 3000);
  assert.equal(pl(build(2026, 'FY', 'all', new Date('2026-12-31T00:00:00Z')), 'chitMargin').total, 5000);
});

test('loan interest by differencing: Monthly, Weekly across a year boundary, Reducing Balance', () => {
  const fy25 = build(2025, 'FY');
  const fy26 = build(2026, 'FY');
  const rec = (r, key, id) => pl(r, key).records.find((x) => x.loanId === id);

  // Monthly: 11 repayments in FY 2025-26, 1 in FY 2026-27, 500 each.
  assert.equal(rec(fy25, 'loanInterest:monthly', 1).amount, 5500);
  assert.equal(rec(fy25, 'loanInterest:monthly', 1).repaymentCount, 11);
  assert.equal(rec(fy26, 'loanInterest:monthly', 1).amount, 500);
  assert.deepEqual(pl(fy25, 'loanInterest:monthly').months, [0, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500]);

  // Weekly: 4,800 received in March 2026 does not cover the 5,000 principal; interest starts in April.
  assert.equal(rec(fy25, 'loanInterest:weekly', 2).amount, 0);
  assert.equal(rec(fy26, 'loanInterest:weekly', 2).amount, 2200);
  assert.equal(pl(fy26, 'loanInterest:weekly').months[0], 2200);
  const allRepayments = loans[1].repayments.map((r) => ({ ...r, paidDate: new Date(r.paidDate) }));
  assert.equal(calculateLoanProfit(loans[1], allRepayments), 2200);

  // Reducing Balance: 120 + 101.20 in Q2, 82.21 in Q3.
  assert.equal(pl(build(2025, 'Q2'), 'loanInterest:reducingBalance').total, 221.2);
  assert.equal(pl(build(2025, 'Q3'), 'loanInterest:reducingBalance').total, 82.21);
  assert.equal(rec(fy25, 'loanInterest:reducingBalance', 3).amount, 303.41);

  // The document charge cancels in the difference and appears once, on the disbursement date.
  const docs = pl(fy25, 'documentCharges');
  assert.equal(docs.total, 300);
  assert.equal(docs.months[0], 300);
  assert.deepEqual(docs.records.map((d) => [d.loanId, d.date]), [[1, '2025-04-05T00:00:00.000Z']]);
  assert.equal(pl(build(2024, 'FY'), 'documentCharges').total, 0);
  // Lifetime: interest over all years + document charge = calculateLoanProfit.
  const lifetime = FYS.reduce((a, fy) => a + paise(rec(build(fy, 'FY'), 'loanInterest:monthly', 1)?.amount || 0), 0);
  assert.equal(lifetime + paise(300), paise(calculateLoanProfit(loans[0], loans[0].repayments.map((r) => ({ ...r, paidDate: new Date(r.paidDate) })))));
});

test('bad debt: written off in the year marked, reopened loan not counted, recovery of principal', () => {
  const fy26 = build(2026, 'FY');
  const writtenOff = pl(fy26, 'badDebtWrittenOff');
  assert.equal(writtenOff.total, 20000);
  assert.deepEqual(writtenOff.records.map((r) => [r.loanId, r.amount, r.outstanding]), [[4, 20000, 15000]]); // loan 5 was restored
  assert.equal(pl(build(2026, 'Q3'), 'badDebtWrittenOff').months[1], 20000); // November
  const recovered = pl(fy26, 'badDebtRecovered');
  assert.equal(recovered.total, 5000);
  assert.deepEqual(recovered.records.map((r) => [r.id, r.loanId, r.amount, r.date]), [[401, 4, 5000, '2026-11-09T18:30:00.000Z']]);
  // Recovery interest is loan interest: 3 × 1,000 + 200 on loan 4.
  assert.equal(pl(fy26, 'loanInterest:monthly').records.find((r) => r.loanId === 4).amount, 3200);
  // Restored loan 5: only its ordinary repayment earns interest; its recovery receipt is not "recovered".
  assert.equal(pl(fy26, 'loanInterest:monthly').records.find((r) => r.loanId === 5).amount, 400);
  assert.equal(pl(fy26, 'loanInterest:monthly').total, 500 + 3200 + 400);
  // The same loan restored → no write-off at all.
  const restored = { ...input, loans: loans.map((l) => (l.id === 4 ? { ...l, status: 'Active', recoveryOutcome: 'Restored' } : l)) };
  assert.equal(pl(build(2026, 'FY', 'all', AS_OF, restored), 'badDebtWrittenOff').total, 0);
  assert.equal(pl(build(2026, 'FY', 'all', AS_OF, restored), 'badDebtRecovered').total, 0);
});

test('Weekly recovery: recovered principal is counted once, as bad debt recovered, not also as interest', () => {
  const loan6 = loans.find((l) => l.id === 6);
  // calculateLoanProfit on its own lowers the Weekly threshold by the 5,000 recovered and calls 500 of it interest.
  const raw = calculateLoanProfit(loan6, loan6.repayments.map((r) => ({ ...r, paidDate: new Date(r.paidDate) })));
  assert.equal(raw, 500);
  const fy25 = build(2025, 'FY');
  assert.equal(pl(fy25, 'loanInterest:weekly').records.find((r) => r.loanId === 6).amount, 0);
  assert.deepEqual(pl(fy25, 'badDebtRecovered').records.map((r) => [r.loanId, r.amount]), [[6, 5000]]);
  assert.deepEqual(pl(fy25, 'badDebtWrittenOff').records.map((r) => [r.loanId, r.amount, r.date]), [[6, 5000, '2026-02-20T06:00:00.000Z']]);
  // Across all years the loan's P&L is −5,000 written off + 5,000 recovered + 0 interest.
  const total = FYS.reduce((a, fy) => {
    const r = build(fy, 'FY');
    const of = (key) => paise(pl(r, key).records.filter((x) => x.loanId === 6).reduce((s, x) => s + x.amount, 0));
    return a + of('loanInterest:weekly') + of('badDebtRecovered') - of('badDebtWrittenOff');
  }, 0);
  assert.equal(total, 0);
});

test('manual entries: each category on its line, only EXPENSE and OTHER_INCOME in the P&L, unclassified warned', () => {
  const fy26 = build(2026, 'FY');
  assert.equal(cash(fy26, 'record:ADVANCE_GIVEN:out').total, 45000);
  assert.equal(cash(fy26, 'record:OTHER_INCOME:in').total, 2400);
  assert.equal(cash(fy26, 'record:ADVANCE_RETURNED:in').total, 5000);
  assert.equal(cash(fy26, 'record:EXPENSE:out').total, 2000);
  assert.equal(pl(fy26, 'otherIncome').total, 2400);
  assert.equal(pl(fy26, 'expenses').total, 2000);
  assert.deepEqual(pl(fy26, 'expenses').records.map((r) => [r.id, r.category, r.note]), [[36, 'EXPENSE', 'party']]);
  assert.equal(cash(fy26, 'record:ADVANCE_GIVEN:out').records[0].category, 'ADVANCE_GIVEN');

  const fy25 = build(2025, 'FY');
  // Opening balance, capital, drawings and corrections never touch the P&L.
  assert.equal(fy25.profitAndLoss.totalIncome.total, 31103.41);
  const warning = fy25.warnings.find((w) => w.code === 'UNCLASSIFIED_ENTRIES');
  assert.equal(warning.count, 3);
  assert.equal(warning.amount, 50000 + 700 + 800);
  assert.deepEqual(warning.records.map((r) => [r.id, r.category]), [[15, null], [23, null], [25, null]]);
  assert.ok(!fy26.warnings.some((w) => w.code === 'UNCLASSIFIED_ENTRIES'));
  // An unclassified row is never income or expense, even with a note that suggests one.
  assert.ok(!pl(fy25, 'expenses').records.some((r) => r.id === 25));
  assert.ok(!pl(fy25, 'otherIncome').records.some((r) => r.id === 23));
});

test('document-charge ledger rows and running-period warnings', () => {
  const fy25 = build(2025, 'FY');
  const doc = fy25.warnings.find((w) => w.code === 'DOCUMENT_CHARGE_LEDGER');
  assert.deepEqual([doc.count, doc.amount, doc.records[0].id], [1, 300, 11]);
  assert.ok(!fy25.warnings.some((w) => w.code === 'PERIOD_RUNNING'));
  assert.equal(fy25.period.status, 'complete');
  assert.equal(fy25.period.asOf, null);
  const fy26 = build(2026, 'FY');
  assert.ok(fy26.warnings.some((w) => w.code === 'PERIOD_RUNNING' && w.message.includes('2026-11-17')));
});

test('running period clamps at asOf; later rows are ignored', () => {
  const r = build(2026, 'FY');
  assert.equal(r.period.status, 'running');
  assert.equal(r.period.asOf, '2026-11-17');
  assert.equal(r.period.endExclusive, '2026-11-17T18:30:00.000Z');
  assert.equal(r.period.fullEndExclusive, '2027-03-31T18:30:00.000Z');
  assert.deepEqual(r.months.map((m) => m.key), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.equal(r.months.at(-1).endExclusive, '2026-11-17T18:30:00.000Z');
  const ids = cash(r, 'chitContributions').records.map((x) => x.id);
  assert.deepEqual(ids, [30, 40]); // 18 Nov and 1 Dec rows excluded
  // Later in the evening of 17 Nov UTC it is already 18 Nov in India: row 41 counts.
  const later = build(2026, 'FY', 'all', new Date('2026-11-17T20:00:00Z'));
  assert.deepEqual(cash(later, 'chitContributions').records.map((x) => x.id), [30, 40, 41]);
  // A period that has not started is empty and opens (and closes) at the cash so far.
  const q4 = build(2026, 'Q4');
  assert.equal(q4.period.status, 'not-started');
  assert.deepEqual(q4.months, []);
  assert.equal(q4.profitAndLoss.netProfit.total, 0);
  assert.equal(q4.cashFlow.opening, r.cashFlow.closing);
  assert.equal(q4.cashFlow.closing, r.cashFlow.closing);
  assert.ok(!q4.warnings.some((w) => w.code === 'PERIOD_RUNNING'));
});

test('scope chits: chit margin and chit cash only, pooled, no partner share', () => {
  const r = build(2025, 'FY', 'chits');
  assert.deepEqual(r.profitAndLoss.income.map((l) => [l.key, l.total]), [['chitMargin', 20000]]);
  assert.deepEqual(r.profitAndLoss.expenses, []);
  assert.equal(r.profitAndLoss.netProfit.total, 20000);
  assert.deepEqual(r.cashFlow.receipts.map((l) => [l.key, l.total]), [['chitContributions', 10000]]);
  assert.deepEqual(r.cashFlow.payments.map((l) => [l.key, l.total]), [['auctionPayouts', 40000]]);
  assert.equal(r.cashFlow.netMovement.total, -30000);
  assert.deepEqual([r.cashFlow.pooled, r.cashFlow.opening, r.cashFlow.closing, r.cashFlow.closingByMonth, r.cashFlow.transfers], [true, null, null, null, null]);
  assert.deepEqual(r.cashFlow.partners, []);
  assert.equal(r.partnerShare, null);
  assert.equal(r.sharedItemsAllocated, false);
  assert.ok(r.notes.some((n) => n.includes('not allocated to Chits')));
  assert.deepEqual(r.warnings, []);
});

test('scope loans: loan income, bad debts and loan cash only', () => {
  const r = build(2025, 'FY', 'loans');
  assert.deepEqual(r.profitAndLoss.income.map((l) => [l.key, l.total]), [
    ['loanInterest:monthly', 5500], ['loanInterest:weekly', 0], ['loanInterest:reducingBalance', 303.41],
    ['documentCharges', 300], ['badDebtRecovered', 5000],
  ]);
  assert.deepEqual(r.profitAndLoss.expenses.map((l) => [l.key, l.total]), [['badDebtWrittenOff', 5000]]);
  assert.equal(r.profitAndLoss.netProfit.total, 6103.41);
  assert.deepEqual(r.cashFlow.receipts.map((l) => [l.key, l.total]), [['loanRepayments', 0], ['documentCharges', 300]]);
  assert.deepEqual(r.cashFlow.payments.map((l) => [l.key, l.total]), [['loanDisbursements', 9700]]);
  assert.equal(r.cashFlow.netMovement.total, -9400);
  assert.equal(r.cashFlow.opening, null);
  assert.equal(r.partnerShare, null);
  assert.ok(r.notes.some((n) => n.includes('not allocated to Loans')));
  assert.deepEqual(r.warnings.map((w) => w.code), ['DOCUMENT_CHARGE_LEDGER']);
  // The older lower-case types count as loan cash too.
  const fy24 = build(2024, 'FY', 'loans');
  assert.equal(fy24.cashFlow.netMovement.total, -9500);
});

test('the report is JSON-serialisable', () => {
  const r = build(2026, 'FY');
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

// ---------------------------------------------------------------------------
// Record Amount categories
// ---------------------------------------------------------------------------

test('category table and direction rules', () => {
  assert.deepEqual(cat.RECORD_AMOUNT_CATEGORIES.map((c) => c.value), cat.RECORD_AMOUNT_CATEGORY_VALUES);
  assert.deepEqual(cat.RECORD_AMOUNT_CATEGORIES.filter((c) => c.profitAndLoss !== 'none').map((c) => [c.value, c.profitAndLoss]), [['OTHER_INCOME', 'income'], ['EXPENSE', 'expense']]);
  for (const c of cat.RECORD_AMOUNT_CATEGORIES) assert.ok(c.label && c.hint && c.cashFlowLabel, c.value);
  assert.equal(cat.isRecordAmountCategory('EXPENSE'), true);
  assert.equal(cat.isRecordAmountCategory('expense'), false);
  assert.equal(cat.isRecordAmountCategory(null), false);
  for (const c of ['OPENING_BALANCE', 'CAPITAL_IN', 'OTHER_INCOME', 'ADVANCE_RETURNED']) {
    assert.deepEqual([cat.categoryAllowsDirection(c, 'credit'), cat.categoryAllowsDirection(c, 'debit')], [true, false], c);
  }
  for (const c of ['DRAWINGS', 'EXPENSE', 'ADVANCE_GIVEN']) {
    assert.deepEqual([cat.categoryAllowsDirection(c, 'credit'), cat.categoryAllowsDirection(c, 'debit')], [false, true], c);
  }
  assert.deepEqual([cat.categoryAllowsDirection('CORRECTION', 'credit'), cat.categoryAllowsDirection('CORRECTION', 'debit')], [true, true]);
});

test('suggestRecordAmountCategory from the note and direction', () => {
  const cases = [
    ['old amount reset', 'credit', 'OPENING_BALANCE'],
    ['Tally old remaining balance', 'credit', 'OPENING_BALANCE'],
    ['old chit fund balance', 'credit', 'OPENING_BALANCE'],
    ['previous 1 lakh chit last amount', 'credit', 'OPENING_BALANCE'],
    ['old loan last due', 'credit', 'OPENING_BALANCE'],
    ['Opening balance', 'credit', 'OPENING_BALANCE'],
    ['Office / operating expense', 'debit', 'EXPENSE'],
    ['food', 'debit', 'EXPENSE'],
    ['Diwali party', 'debit', 'EXPENSE'],
    ['sweet box', 'debit', 'EXPENSE'],
    ['members get-to-gether', 'debit', 'EXPENSE'],
    ['car rent', 'credit', 'OTHER_INCOME'],
    ['Capital investment', 'credit', 'CAPITAL_IN'],
    ['Capital withdrawal', 'debit', 'DRAWINGS'],
    ['Balance correction', 'credit', 'CORRECTION'],
    ['Balance correction', 'debit', 'CORRECTION'],
    ['advance for car', 'debit', 'ADVANCE_GIVEN'],
    ['advance returned', 'credit', 'ADVANCE_RETURNED'],
    // Unknown, or a category that does not allow the direction.
    ['misc', 'debit', null],
    ['misc', 'credit', null],
    ['', 'credit', null],
    [null, 'debit', null],
    ['old amount reset', 'debit', null],
    ['food', 'credit', null],
    ['Capital investment', 'debit', null],
    ['Capital withdrawal', 'credit', null],
    ['gold chit', 'credit', null],
  ];
  for (const [note, direction, expected] of cases) {
    assert.equal(cat.suggestRecordAmountCategory(note, direction), expected, `${note} (${direction})`);
  }
});
