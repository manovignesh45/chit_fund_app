// Run with: node tests/test-amount-flow-tally.js. No database connection or writes.
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', jsx: 'react-jsx' });
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { computeAmountFlowTally, matchDocumentCharges } = require('../lib/amountFlowTally');
const { calculateTotalFinancialMetrics, calculatePeriodFinancialMetrics, loanCashGiven } = require('../lib/centralizedFinancialCalculations');

const rowOf = (tally, key) => tally.rows.find((r) => r.key === key);
const day = '2026-03-19T00:00:00.000Z';

// A small book: invested 50,000; contributions 30,000; repayments 12,000;
// payouts 40,000; one loan of 20,000 with no document charge.
const base = {
  investedNet: 50000,
  records: { contributions: 30000, repayments: 12000, auctionPayouts: 40000, loanCashGiven: 20000 },
  ledgerByType: { CHIT_CONTRIBUTION: 30000, LOAN_REPAYMENT: 12000, AUCTION_PAYOUT: 40000, LOAN_DISBURSEMENT: 20000, PARTNER_TO_PARTNER: 9000 },
  ledgerBalance: 32000,
  runningBalance: 32000,
  loans: [{ id: 1, borrower: 'Asha', amount: 20000, documentCharge: 0, disbursementTransactionDate: day, ledgerDisbursed: 20000 }],
  documentCharges: [],
};

test('fully tallied: records, ledger and balance agree', () => {
  const t = computeAmountFlowTally(base);
  // 50,000 + 30,000 + 12,000 − 40,000 − 20,000
  assert.equal(t.recordsExpectedBalance, 32000);
  assert.equal(t.ledgerComputedBalance, 32000);
  assert.equal(t.ledgerBalance, 32000);
  assert.equal(t.difference, 0);
  assert.equal(t.tallied, true);
  assert.deepEqual(t.moneyIn, { records: 92000, ledger: 92000 });
  assert.deepEqual(t.moneyOut, { records: 60000, ledger: 60000 });
  assert.equal(t.ledgerComputedDifference, 0);
  assert.equal(t.runningBalanceDifference, 0);
  for (const r of t.rows) assert.equal(r.difference, 0, r.key);
  // Partner transfers do not move the total, so they get no row.
  assert.equal(t.rows.some((r) => r.key.includes('PARTNER_TO_PARTNER')), false);
  assert.deepEqual(rowOf(t, 'invested'), { key: 'invested', label: 'Invested (net)', direction: 'in', records: 50000, ledger: 50000, difference: 0 });
  assert.deepEqual(t.loanDetails, []);
  assert.deepEqual(t.unmatchedDocumentCharges, []);
});

test('double-counted document charge: disbursement = amount − doc plus a DOCUMENT_CHARGE entry', () => {
  // Loan 20,700 with doc 700: borrower got 20,000; the ledger also took 700 in as cash.
  const t = computeAmountFlowTally({
    ...base,
    records: { ...base.records, loanCashGiven: 20000 },
    ledgerByType: { ...base.ledgerByType, LOAN_DISBURSEMENT: 20000, DOCUMENT_CHARGE: 700 },
    ledgerBalance: 32700,
    runningBalance: 32700,
    loans: [{ id: 20, borrower: 'Sarath', amount: 20700, documentCharge: 700, disbursementTransactionDate: day, ledgerDisbursed: 20000 }],
    documentCharges: [{ id: 436, amount: 700, date: day, note: 'Document charge for loan to Sarath' }],
  });
  assert.equal(t.recordsExpectedBalance, 32000);
  assert.equal(t.ledgerBalance, 32700);
  assert.equal(t.difference, 700); // the ledger holds 700 the records never received
  assert.equal(t.tallied, false);
  assert.equal(rowOf(t, 'loanCashGiven').difference, 0);
  assert.deepEqual(rowOf(t, 'documentCharges'), {
    key: 'documentCharges', label: 'Document charges (kept back from loans)', direction: 'in', records: 0, ledger: 700, difference: 700,
  });
  assert.equal(t.loanDetails.length, 1);
  assert.deepEqual(t.loanDetails[0], {
    id: 20, borrower: 'Sarath', amount: 20700, documentCharge: 700, cashGiven: 20000,
    ledgerDisbursed: 20000, ledgerDocumentCharge: 700, documentChargeTransactionId: 436, difference: 700,
  });
  assert.deepEqual(t.unmatchedDocumentCharges, []);
});

test('old-style loan: disbursement = full amount, no document-charge entry', () => {
  // Loan 25,000 with doc 1,500: the borrower got 23,500 but the ledger paid out 25,000.
  const t = computeAmountFlowTally({
    ...base,
    records: { ...base.records, loanCashGiven: 23500 },
    ledgerByType: { ...base.ledgerByType, LOAN_DISBURSEMENT: 25000 },
    ledgerBalance: 27000,
    runningBalance: 27000,
    loans: [{ id: 3, borrower: 'Arun', amount: 25000, documentCharge: 1500, disbursementTransactionDate: day, ledgerDisbursed: 25000 }],
  });
  assert.equal(t.recordsExpectedBalance, 28500); // 92,000 − 40,000 − 23,500
  assert.equal(t.difference, -1500);
  const cash = rowOf(t, 'loanCashGiven');
  assert.equal(cash.records, 23500);
  assert.equal(cash.ledger, 25000);
  assert.equal(cash.difference, -1500); // out row: records − ledger
  assert.equal(rowOf(t, 'documentCharges').difference, 0);
  assert.equal(t.loanDetails.length, 1);
  assert.equal(t.loanDetails[0].difference, -1500);
  assert.equal(t.loanDetails[0].ledgerDocumentCharge, null);
});

test('other ledger entries (expense) get their own row with no records', () => {
  const t = computeAmountFlowTally({
    ...base,
    ledgerByType: { ...base.ledgerByType, expense: 2500, transfer: 4000, mystery: 99 },
    ledgerBalance: 29500,
    runningBalance: 29500,
  });
  const expense = rowOf(t, 'other:expense');
  assert.deepEqual(expense, { key: 'other:expense', label: 'Expenses', direction: 'out', records: 0, ledger: 2500, difference: -2500 });
  // Transfers and unknown types do not move the total balance.
  assert.equal(rowOf(t, 'other:transfer'), undefined);
  assert.equal(rowOf(t, 'other:mystery'), undefined);
  assert.equal(t.ledgerComputedBalance, 29500);
  assert.equal(t.difference, -2500);
  assert.equal(t.rows.reduce((s, r) => s + r.difference, 0), t.difference, 'row differences add up to the headline');
});

test('stale running balance is reported separately from the records difference', () => {
  const t = computeAmountFlowTally({ ...base, runningBalance: 35400 });
  assert.equal(t.tallied, true);
  assert.equal(t.runningBalance, 35400);
  assert.equal(t.runningBalanceDifference, 3400);
  // A partner-balance total that the per-type sums do not explain (e.g. an entry with no partner).
  const u = computeAmountFlowTally({ ...base, ledgerBalance: 31000, runningBalance: 31000 });
  assert.equal(u.ledgerComputedBalance, 32000);
  assert.equal(u.ledgerComputedDifference, 1000);
  assert.equal(u.difference, -1000);
  assert.equal(computeAmountFlowTally({ ...base, runningBalance: null }).runningBalanceDifference, null);
});

test('the user\'s book: −2,300 from two double-counted and four old-style loans', () => {
  const loans = [
    { id: 3, borrower: 'Arunkumar', amount: 25000, documentCharge: 1500, disbursementTransactionDate: '2024-11-11', ledgerDisbursed: 25000 },
    { id: 5, borrower: 'Bhuvanesh', amount: 26000, documentCharge: 1000, disbursementTransactionDate: '2025-01-12', ledgerDisbursed: 26000 },
    { id: 8, borrower: 'Sarath', amount: 15000, documentCharge: 500, disbursementTransactionDate: '2025-01-11', ledgerDisbursed: 15000 },
    { id: 10, borrower: 'Sarath', amount: 20000, documentCharge: 1000, disbursementTransactionDate: '2025-05-06', ledgerDisbursed: 20000 },
    { id: 16, borrower: 'Arunkumar', amount: 30000, documentCharge: 1000, disbursementTransactionDate: '2025-12-04', ledgerDisbursed: 29000 },
    { id: 20, borrower: 'Sarath', amount: 20700, documentCharge: 700, disbursementTransactionDate: '2026-03-19', ledgerDisbursed: 20000 },
    { id: 9, borrower: 'Mano', amount: 40000, documentCharge: 0, disbursementTransactionDate: '2025-04-15', ledgerDisbursed: 40000 },
  ];
  const t = computeAmountFlowTally({
    investedNet: 94624,
    records: { contributions: 1451150, repayments: 357000, auctionPayouts: 1462800, loanCashGiven: 384000 },
    ledgerByType: { CHIT_CONTRIBUTION: 1451150, LOAN_REPAYMENT: 357000, AUCTION_PAYOUT: 1462800, LOAN_DISBURSEMENT: 388000, DOCUMENT_CHARGE: 1700, PARTNER_TO_PARTNER: 1553260 },
    ledgerBalance: 53674,
    runningBalance: 53674,
    loans,
    documentCharges: [
      { id: 291, amount: 1000, date: '2025-12-04', note: 'Document charge for loan to Arunkumar' },
      { id: 436, amount: 700, date: '2026-03-19', note: 'Document charge for loan to Sarath' },
    ],
  });
  assert.equal(t.recordsExpectedBalance, 55974);
  assert.equal(t.ledgerComputedBalance, 53674);
  assert.equal(t.difference, -2300);
  assert.equal(rowOf(t, 'loanCashGiven').difference, -4000);
  assert.equal(rowOf(t, 'documentCharges').difference, 1700);
  assert.deepEqual(t.loanDetails.map((l) => [l.id, l.difference]), [[3, -1500], [5, -1000], [8, -500], [10, -1000], [16, 1000], [20, 700]]);
  assert.equal(t.loanDetails.reduce((s, l) => s + l.difference, 0), -2300);
});

test('document-charge matching needs date, amount and borrower; leftovers are listed', () => {
  const loans = [{ id: 1, borrower: 'Sarath', amount: 20700, documentCharge: 700, disbursementTransactionDate: day, ledgerDisbursed: 20000 }];
  const charges = [
    { id: 10, amount: 700, date: '2026-03-20', note: 'Document charge for loan to Sarath' }, // other day
    { id: 11, amount: 700, date: day, note: 'Document charge for loan to Arun' }, // other borrower
    { id: 12, amount: 700, date: day, note: 'Document charge for loan to Sarath' },
  ];
  const { byLoan, unmatched } = matchDocumentCharges(loans, charges);
  assert.equal(byLoan.get(1).id, 12);
  assert.deepEqual(unmatched.map((c) => c.id), [10, 11]);
});

test('cash outflow counts the cash given (amount − document charge); profit still counts the charge', () => {
  const loan = { id: 1, amount: 10000, documentCharge: 500, loanType: 'Monthly', repaymentType: 'Monthly',
    interestRate: 0, remainingAmount: 10000, disbursementDate: new Date('2026-08-01'), repayments: [] };
  assert.equal(loanCashGiven(loan), 9500);
  const total = calculateTotalFinancialMetrics([loan], []);
  assert.equal(total.loanOutflow, 9500);
  assert.equal(total.loanPrincipalDisbursed, 10000);
  assert.equal(total.totalCashOutflow, 9500);
  assert.equal(total.documentCharges, 500);
  assert.equal(total.loanProfit, 500);
  assert.equal(total.loanRemainingAmount, 10000);
  const period = calculatePeriodFinancialMetrics([loan], [], [{ id: 1, amount: 10000, documentCharge: 500 }], {
    startDate: new Date('2026-08-01'), endDate: new Date('2026-08-31'),
  });
  assert.equal(period.loanOutflow, 9500);
  assert.equal(period.loanPrincipalDisbursed, 10000);
  assert.equal(period.totalCashOutflow, 9500);
  assert.equal(period.documentCharges, 500);
});
