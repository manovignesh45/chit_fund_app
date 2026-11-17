// Run with: node tests/test-itr-report-excel.js. No database connection or writes.
// The tax report's Excel export (lib/itrReportExcel.ts): build a report from fixture data, write
// the workbook, read it back with exceljs and check that every figure equals the report.
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', jsx: 'react-jsx' });
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ExcelJS = require('exceljs');

const { buildItrReport } = require('../lib/itrReport');
const X = require('../lib/itrReportExcel');

const paise = (n) => Math.round(n * 100);
const AS_OF = new Date('2026-11-17T10:00:00Z');
const GENERATED = new Date('2026-11-17T10:00:00Z');

// ---------------------------------------------------------------------------
// Fixture: two partners, one chit fund, Monthly / Weekly / Reducing Balance loans, a
// written-off loan with a recovery, manual entries of every kind, transfers.
// ---------------------------------------------------------------------------

const partners = [{ id: 1, name: 'Ravi' }, { id: 2, name: 'Kumar' }];
const winner = (name) => ({ globalMember: { name } });
const D = (d) => `${d}T00:00:00Z`;

const chitFunds = [{
  id: 1, name: 'Gold 1L', monthlyContribution: 5000, firstMonthContribution: 4000, duration: 10, chitFundType: 'Fixed',
  auctions: [
    { id: 11, month: 1, amount: 40000, date: D('2025-05-10'), winner: winner('Asha') },
    { id: 12, month: 2, amount: 42000, date: D('2025-10-10'), winner: winner('Bala') },
    { id: 13, month: 3, amount: 45000.5, date: D('2026-03-31'), winner: null },
  ],
}];

const monthly = (id, from, count, amount) => Array.from({ length: count }, (_, i) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + i);
  return { id: id * 100 + i + 1, amount, paidDate: d.toISOString(), period: i + 1, paymentType: 'full' };
});

const loans = [
  { id: 1, borrower: { name: 'Mani' }, amount: 210000, interestRate: 500, documentCharge: 300, repaymentType: 'Monthly', loanType: 'Monthly',
    disbursementDate: D('2025-04-05'), status: 'Active', remainingAmount: 0, repayments: monthly(1, D('2025-05-05'), 12, 1333) },
  { id: 2, borrower: { name: 'Nila' }, amount: 5000, interestRate: 0, documentCharge: 150, repaymentType: 'Weekly', loanType: 'Weekly',
    disbursementDate: D('2026-03-01'), status: 'Completed', remainingAmount: 0,
    repayments: ['2026-03-08', '2026-03-15', '2026-03-22', '2026-03-29', '2026-04-05'].map((d, i) => ({ id: 200 + i, amount: 1200, paidDate: D(d), period: i + 1, paymentType: 'full' })) },
  { id: 3, borrower: { name: 'Oviya' }, amount: 12000, interestRate: 0, interestPercentage: 12, documentCharge: 0, repaymentType: 'Monthly', loanType: 'Reducing Balance',
    disbursementDate: D('2025-07-01'), status: 'Active', remainingAmount: 6303.41, repayments: monthly(3, D('2025-08-01'), 3, 2000) },
  { id: 6, borrower: { name: 'Selvi' }, amount: 10000, interestRate: 0, documentCharge: 0, repaymentType: 'Weekly', loanType: 'Weekly',
    disbursementDate: D('2025-12-01'), status: 'Non-Recoverable', nonRecoverableAt: '2026-02-20T06:00:00Z', recoveryPrincipalAtMark: 5000, remainingAmount: 0,
    repayments: [{ id: 601, amount: 1100, paidDate: D('2025-12-08'), period: 1, paymentType: 'full' },
      { id: 602, amount: 2500, paidDate: '2026-03-09T18:30:00Z', period: 0, paymentType: 'RECOVERY', principalComponent: 2500, interestComponent: 0 }] },
];

const tx = (id, type, date, amount, extra = {}) => ({ id, type, date, amount, note: null, category: null, from_partner_id: null, to_partner_id: null, ...extra });
const credit = (id, date, amount, category, note, partner) => tx(id, 'RECORD_AMOUNT', date, amount, { category, note, to_partner_id: partner });
const debit = (id, date, amount, category, note, partner) => tx(id, 'RECORD_AMOUNT', date, amount, { category, note, from_partner_id: partner });

const transactions = [
  tx(1, 'loan_given', D('2024-11-01'), 10000, { from_partner_id: 1 }),
  tx(10, 'LOAN_DISBURSEMENT', D('2025-04-05'), 209700, { from_partner_id: 1 }),
  tx(11, 'DOCUMENT_CHARGE', D('2025-04-05'), 300, { to_partner_id: 1 }),
  tx(12, 'CHIT_CONTRIBUTION', D('2025-05-01'), 4000, { to_partner_id: 1 }),
  tx(13, 'AUCTION_PAYOUT', D('2025-05-10'), 40000, { from_partner_id: 2 }),
  credit(14, D('2025-06-30'), 144424.5, 'OPENING_BALANCE', 'old amount reset', 1),
  credit(15, D('2025-06-30'), 50000, null, 'tally old remaining balance', 2),
  tx(16, 'PARTNER_TO_PARTNER', D('2025-07-15'), 20000, { from_partner_id: 1, to_partner_id: 2 }),
  tx(17, 'CHIT_CONTRIBUTION', D('2025-08-01'), 1000), // no partner: Unassigned
  tx(18, 'LOAN_REPAYMENT', D('2025-08-05'), 1333, { to_partner_id: 2 }),
  credit(19, D('2025-11-01'), 10000.33, 'CAPITAL_IN', 'capital investment', 1),
  debit(20, D('2025-12-20'), 1200, 'EXPENSE', 'Office tea', 1),
  debit(21, D('2026-01-10'), 5000, 'DRAWINGS', 'capital withdrawal', 2),
  credit(22, D('2026-02-15'), 2400, 'OTHER_INCOME', 'car rent', 2),
  debit(23, D('2026-03-20'), 800, null, 'food for meeting', 1),
  tx(24, 'transfer', D('2026-03-25'), 3000, { from_partner_id: 2, to_partner_id: 1 }),
  tx(25, 'collection', D('2026-03-26'), 300, { to_partner_id: 2 }),
];

const input = { transactions, loans, chitFunds, partners };
const build = (fy, period, scope = 'all', data = input) => buildItrReport(data, { fy, period, scope, asOf: AS_OF });

async function workbookOf(report, options = {}) {
  const buffer = await X.buildItrReportXlsx(report, { generatedAt: GENERATED, unclassifiedCount: 2, partners, ...options });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

const raw = (cell) => (cell.value === null || cell.value === undefined ? '' : String(cell.value));
const text = (cell) => raw(cell).trim();
/** Rows whose cell in `column` is `label` (trimmed). Statement lines are indented: pass LINE(label) to match exactly. */
function rowsLabelled(ws, label, column = 1) {
  const exact = label.startsWith('   ');
  const rows = [];
  ws.eachRow((row) => {
    if ((exact ? raw(row.getCell(column)) : text(row.getCell(column))) === label) rows.push(row);
  });
  return rows;
}
const LINE = (label) => `   ${label}`;
function rowLabelled(ws, label, column = 1) {
  const rows = rowsLabelled(ws, label, column);
  assert.equal(rows.length, 1, `${ws.name}: one row "${label}" (found ${rows.length})`);
  return rows[0];
}
/** Data rows below the header (row 3) up to the first row whose first cell is `stop`. */
function dataRows(ws, stop) {
  const rows = [];
  for (let r = 4; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (text(row.getCell(1)) === stop || text(row.getCell(2)) === stop) break;
    if (row.cellCount === 0 || row.values.length === 0) continue;
    rows.push(row);
  }
  return rows;
}
const num = (cell) => {
  assert.equal(typeof cell.value, 'number', `cell ${cell.address} is a number (got ${JSON.stringify(cell.value)})`);
  return cell.value;
};
// exceljs drops the backslashes of a number format when it reads one back; the file has them (see the formatting test).
const plain = (numFmt) => (typeof numFmt === 'string' ? numFmt.replace(/\\/g, '') : numFmt);
const isMoneyFormat = (numFmt) => Object.values(X.MONEY_FORMATS).some((f) => plain(f) === plain(numFmt));
const money = (cell) => {
  assert.ok(isMoneyFormat(cell.numFmt), `cell ${cell.address} has a money format (got ${cell.numFmt})`);
  assert.equal(plain(cell.numFmt), plain(X.moneyFormat(cell.value)), `cell ${cell.address}: the format for its size`);
  return num(cell);
};
const allZero = (s) => s.total === 0 && s.months.every((m) => m === 0);

/** Every shown line of a statement sheet: month cells and total equal the report; hidden lines are all zero. */
function assertStatementLines(ws, report, lines) {
  const n = report.months.length;
  for (const line of lines) {
    const rows = rowsLabelled(ws, LINE(line.label));
    if (allZero(line)) {
      assert.equal(rows.length, 0, `${ws.name}: all-zero line "${line.label}" is left out, as on the page`);
      continue;
    }
    assert.equal(rows.length, 1, `${ws.name}: line "${line.label}"`);
    assertSeriesRow(rows[0], line, n, `${ws.name}: ${line.label}`);
  }
}
function assertSeriesRow(row, series, n, label) {
  for (let i = 0; i < n; i++) assert.equal(paise(money(row.getCell(2 + i))), paise(series.months[i]), `${label} month ${i + 1}`);
  assert.equal(paise(money(row.getCell(2 + n))), paise(series.total), `${label} total`);
}

const REPORTS = [
  ['FY 2025-26 all', () => build(2025, 'FY', 'all')],
  ['Q4 2025-26 all', () => build(2025, 'Q4', 'all')],
  ['FY 2025-26 chits', () => build(2025, 'FY', 'chits')],
  ['H1 2025-26 loans', () => build(2025, 'H1', 'loans')],
  ['FY 2026-27 running', () => build(2026, 'FY', 'all')],
];

// ---------------------------------------------------------------------------

test('sheet names per scope', async () => {
  assert.deepEqual(X.itrExportSheetNames('all'), ['Summary', 'Profit & loss', 'Cash flow', 'Chit payouts', 'Loan income', 'Manual entries', 'Bad debts', 'Ledger', 'Notes']);
  assert.deepEqual(X.itrExportSheetNames('chits'), ['Summary', 'Profit & loss', 'Cash flow', 'Chit payouts', 'Ledger', 'Notes']);
  assert.deepEqual(X.itrExportSheetNames('loans'), ['Summary', 'Profit & loss', 'Cash flow', 'Loan income', 'Bad debts', 'Ledger', 'Notes']);
  for (const scope of ['all', 'chits', 'loans']) {
    const wb = await workbookOf(build(2025, 'FY', scope));
    assert.deepEqual(wb.worksheets.map((ws) => ws.name), X.itrExportSheetNames(scope), scope);
  }
});

test('file names', () => {
  assert.equal(X.itrExportFileName(build(2025, 'Q1', 'all')), 'tax-report-FY2025-26-Q1-all.xlsx');
  assert.equal(X.itrExportFileName(build(2025, 'FY', 'loans')), 'tax-report-FY2025-26-loans.xlsx');
  assert.equal(X.itrExportFileName(build(2024, 'H2', 'chits')), 'tax-report-FY2024-25-H2-chits.xlsx');
  assert.equal(X.itrExportFileName(build(2026, 'FY', 'all')), 'tax-report-FY2026-27-all-to-2026-11-17.xlsx', 'a running period carries its as-of day');
  assert.equal(X.itrExportFileName(build(2026, 'Q4', 'all')), 'tax-report-FY2026-27-Q4-all.xlsx', 'not started: no as-of day');
});

test('Summary: period, P&L totals, net profit, partner shares and cash equal the report', async () => {
  for (const [label, make] of REPORTS) {
    const report = make();
    const ws = (await workbookOf(report)).getWorksheet('Summary');
    const value = (name) => rowLabelled(ws, name).getCell(2);
    const pl = report.profitAndLoss;
    assert.equal(paise(money(value('Total income'))), paise(pl.totalIncome.total), `${label}: total income`);
    if (pl.expenses.length) assert.equal(paise(money(value('Total expenses'))), paise(pl.totalExpenses.total), `${label}: total expenses`);
    const netLabel = report.sharedItemsAllocated ? 'Net profit' : `Net profit (${report.period.scope === 'chits' ? 'Chits' : 'Loans'}, before shared items)`;
    assert.equal(paise(money(value(netLabel))), paise(pl.netProfit.total), `${label}: net profit`);
    for (const l of [...pl.income, ...pl.expenses].filter((l) => !allZero(l))) {
      assert.equal(paise(money(value(LINE(l.label)))), paise(l.total), `${label}: ${l.label}`);
    }
    if (report.partnerShare) {
      for (const p of report.partnerShare.partners) assert.equal(paise(money(value(p.name))), paise(p.share), `${label}: ${p.name}'s share`);
      assert.equal(paise(money(value('Net profit shared'))), paise(report.partnerShare.netProfit));
      assert.equal(paise(money(value('Opening cash'))), paise(report.cashFlow.opening), `${label}: opening cash`);
      assert.equal(paise(money(value('Closing cash'))), paise(report.cashFlow.closing), `${label}: closing cash`);
    } else {
      assert.ok(rowsLabelled(ws, 'Shared items').length === 1, `${label}: says shared items are not allocated`);
      let said = false;
      ws.eachRow((row) => { if (/not allocated to (Chits|Loans)/.test(text(row.getCell(1)))) said = true; });
      assert.ok(said, `${label}: shared expenses and other income are not allocated`);
    }
    assert.equal(paise(money(value('Net cash movement'))), paise(report.cashFlow.netMovement.total), `${label}: net cash movement`);
    assert.equal(text(value('Period')), report.period.label);
    assert.equal(text(value('Financial year')), report.period.fiscalYearLabel);
    assert.ok(value('From').value instanceof Date, 'From is a date');
    assert.ok(value('To').value instanceof Date, 'To is a date');
    assert.ok(value('Generated').value instanceof Date, 'Generated is a date');
    assert.equal(rowsLabelled(ws, 'To date as of').length, report.period.status === 'running' ? 1 : 0, `${label}: as-of row only when running`);
  }
  // The dates are the IST calendar days, written as dates.
  const ws = (await workbookOf(build(2025, 'Q1'))).getWorksheet('Summary');
  assert.equal(rowLabelled(ws, 'From').getCell(2).value.toISOString(), '2025-04-01T00:00:00.000Z');
  assert.equal(rowLabelled(ws, 'To').getCell(2).value.toISOString(), '2025-06-30T00:00:00.000Z');
  assert.equal(rowLabelled(ws, 'Generated').getCell(2).value.toISOString(), '2026-11-17T15:30:00.000Z', 'generated time is IST wall-clock');
  const running = (await workbookOf(build(2026, 'FY'))).getWorksheet('Summary');
  assert.equal(rowLabelled(running, 'To date as of').getCell(2).value.toISOString(), '2026-11-17T00:00:00.000Z');
});

test('Summary warnings: each warning and the entries still to classify', async () => {
  const report = build(2025, 'FY');
  const codes = report.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['DOCUMENT_CHARGE_LEDGER', 'NEGATIVE_CLOSING_CASH', 'NEGATIVE_OPENING_CASH', 'UNCLASSIFIED_ENTRIES']);
  const ws = (await workbookOf(report, { unclassifiedCount: 7 })).getWorksheet('Summary');
  const unclassified = rowLabelled(ws, 'Unclassified manual entries');
  assert.equal(paise(money(unclassified.getCell(2))), paise(report.warnings.find((w) => w.code === 'UNCLASSIFIED_ENTRIES').amount));
  assert.match(text(unclassified.getCell(3)), /^2 manual entries in this period have no category/);
  assert.ok(rowLabelled(ws, 'Document-charge ledger entries'));
  assert.equal(money(rowLabelled(ws, 'Negative opening cash').getCell(2)), report.cashFlow.opening);
  assert.equal(money(rowLabelled(ws, 'Negative closing cash').getCell(2)), report.cashFlow.closing);
  assert.ok(report.cashFlow.closing < 0);
  assert.equal(rowLabelled(ws, 'Entries to classify (any date)').getCell(2).value, 7);
  const clean = (await workbookOf(build(2025, 'Q1', 'chits'), { unclassifiedCount: 0 })).getWorksheet('Summary');
  assert.equal(rowsLabelled(clean, 'None').length, 1, 'no warnings: says None');
});

test('Profit & loss and Cash flow: every line\'s month cells and total equal the report', async () => {
  for (const [label, make] of REPORTS) {
    const report = make();
    const wb = await workbookOf(report);
    const n = report.months.length;
    const plWs = wb.getWorksheet('Profit & loss');
    // Header: Line, each month, Total.
    const header = plWs.getRow(3);
    assert.deepEqual(Array.from({ length: n + 2 }, (_, i) => text(header.getCell(i + 1))), ['Line', ...report.months.map((m) => m.label), 'Total'], `${label}: P&L header`);
    const pl = report.profitAndLoss;
    assertStatementLines(plWs, report, [...pl.income, ...pl.expenses]);
    assertSeriesRow(rowLabelled(plWs, 'Total income'), pl.totalIncome, n, `${label}: total income`);
    if (pl.expenses.length) assertSeriesRow(rowLabelled(plWs, 'Total expenses'), pl.totalExpenses, n, `${label}: total expenses`);
    assertSeriesRow(rowLabelled(plWs, 'Net profit'), pl.netProfit, n, `${label}: net profit`);

    const cashWs = wb.getWorksheet('Cash flow');
    const cf = report.cashFlow;
    assertStatementLines(cashWs, report, [...cf.receipts, ...cf.payments]);
    assertSeriesRow(rowLabelled(cashWs, 'Total receipts'), cf.totalReceipts, n, `${label}: total receipts`);
    assertSeriesRow(rowLabelled(cashWs, 'Total payments'), cf.totalPayments, n, `${label}: total payments`);
    assertSeriesRow(rowLabelled(cashWs, 'Net cash movement'), cf.netMovement, n, `${label}: net movement`);
    if (cf.pooled) {
      assert.equal(rowsLabelled(cashWs, 'Opening balance').length, 0);
      assert.equal(rowsLabelled(cashWs, 'Closing balance').length, 0);
      assert.equal(rowsLabelled(cashWs, 'Cash held by each partner').length, 0);
      continue;
    }
    assertSeriesRow(rowLabelled(cashWs, 'Opening balance'), { months: [cf.opening, ...cf.closingByMonth.slice(0, -1)], total: cf.opening }, n, `${label}: opening`);
    assertSeriesRow(rowLabelled(cashWs, 'Closing balance'), { months: cf.closingByMonth, total: cf.closing }, n, `${label}: closing`);
    assertSeriesRow(rowLabelled(cashWs, cf.transfers.label), cf.transfers, n, `${label}: transfers memo`);
    // Partner-wise cash, with each partner's share.
    for (const p of cf.partners) {
      const row = rowLabelled(cashWs, p.name);
      const expected = [p.opening, p.in, p.out, p.transfersIn, p.transfersOut, p.closing];
      expected.forEach((v, i) => assert.equal(paise(money(row.getCell(2 + i))), paise(v), `${label}: ${p.name} column ${i + 2}`));
      const share = report.partnerShare.partners.find((s) => s.partnerId === p.partnerId);
      if (share) assert.equal(paise(money(row.getCell(8))), paise(share.share));
    }
    const total = rowsLabelled(cashWs, 'Total').at(-1);
    assert.equal(paise(money(total.getCell(2))), paise(cf.opening));
    assert.equal(paise(money(total.getCell(7))), paise(cf.closing));
    assert.equal(paise(money(total.getCell(8))), paise(report.partnerShare.netProfit));
  }
});

test('Chit payouts: one row per payout, margins and total equal the report', async () => {
  for (const [label, make] of REPORTS.filter(([l]) => !l.includes('loans'))) {
    const report = make();
    const ws = (await workbookOf(report)).getWorksheet('Chit payouts');
    const line = report.profitAndLoss.income.find((l) => l.key === 'chitMargin');
    const rows = dataRows(ws, 'Total');
    if (!line.records.length) {
      assert.equal(text(ws.getRow(4).getCell(1)), 'None in this period.');
      continue;
    }
    assert.equal(rows.length, line.records.length, `${label}: rows`);
    rows.forEach((row, i) => {
      const r = line.records[i];
      assert.ok(row.getCell(1).value instanceof Date, 'payout date is a date');
      assert.equal(row.getCell(1).numFmt, X.DATE_FORMAT);
      assert.equal(text(row.getCell(2)), r.fundName);
      assert.equal(num(row.getCell(3)), r.month);
      assert.equal(text(row.getCell(4)), r.member ?? '');
      assert.equal(paise(money(row.getCell(5))), paise(r.termContribution));
      assert.equal(paise(money(row.getCell(6))), paise(r.payout));
      assert.equal(paise(money(row.getCell(7))), paise(r.amount));
    });
    const total = rowLabelled(ws, 'Total');
    assert.equal(paise(money(total.getCell(7))), paise(line.total), `${label}: margin total`);
    assert.equal(paise(money(total.getCell(6))), line.records.reduce((a, r) => a + paise(r.payout), 0));
  }
  // Term contribution 4,000 + 9 × 5,000 = 49,000; margins 9,000 + 7,000 + 3,999.50.
  const fy = (await workbookOf(build(2025, 'FY'))).getWorksheet('Chit payouts');
  assert.equal(rowLabelled(fy, 'Total').getCell(7).value, 19999.5);
  assert.equal(rowLabelled(fy, 'Total').getCell(5).value, 49000 * 3);
});

test('Loan income: interest per loan, document charges, totals equal the report', async () => {
  for (const [label, make] of REPORTS.filter(([l]) => !l.includes('chits'))) {
    const report = make();
    const ws = (await workbookOf(report)).getWorksheet('Loan income');
    const interestLines = report.profitAndLoss.income.filter((l) => l.key.startsWith('loanInterest:'));
    const records = interestLines.flatMap((l) => l.records);
    const rows = [];
    for (let r = 4; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (typeof row.getCell(1).value === 'number' && typeof row.getCell(4).value === 'number') rows.push(row);
      if (text(row.getCell(2)) === 'Total loan interest') break;
    }
    assert.equal(rows.length, records.length, `${label}: one row per loan with interest`);
    for (const row of rows) {
      const r = records.find((x) => x.loanId === row.getCell(1).value);
      assert.ok(r, `${label}: loan ${row.getCell(1).value}`);
      assert.equal(text(row.getCell(2)), r.borrower);
      assert.equal(num(row.getCell(4)), r.repaymentCount);
      assert.equal(paise(money(row.getCell(5))), paise(r.amount));
    }
    for (const l of interestLines) assert.equal(paise(money(rowLabelled(ws, l.label, 2).getCell(5))), paise(l.total), `${label}: ${l.label}`);
    assert.equal(paise(money(rowLabelled(ws, 'Total loan interest', 2).getCell(5))), interestLines.reduce((a, l) => a + paise(l.total), 0));

    const docs = report.profitAndLoss.income.find((l) => l.key === 'documentCharges');
    if (docs.records.length) {
      const docRows = [];
      ws.eachRow((row) => { if (row.getCell(4).value instanceof Date) docRows.push(row); });
      assert.equal(docRows.length, docs.records.length, `${label}: document charge rows`);
      docRows.forEach((row, i) => assert.equal(paise(money(row.getCell(5))), paise(docs.records[i].amount)));
      assert.equal(paise(money(rowLabelled(ws, 'Total document charges', 2).getCell(5))), paise(docs.total));
    }
  }
});

test('Manual entries: every Record Amount row of the period, with category, direction and totals', async () => {
  const report = build(2025, 'FY');
  const ws = (await workbookOf(report)).getWorksheet('Manual entries');
  const cf = report.cashFlow;
  const manual = [...cf.receipts, ...cf.payments].flatMap((l) => l.records).filter((r) => r.type === 'RECORD_AMOUNT');
  assert.equal(manual.length, 7);
  const rows = dataRows(ws, 'Total credits');
  assert.equal(rows.length, manual.length);
  const byId = new Map(rows.map((row) => [row.getCell(2).value, row]));
  for (const r of manual) {
    const row = byId.get(r.id);
    assert.ok(row, `entry ${r.id}`);
    assert.ok(row.getCell(1).value instanceof Date);
    assert.equal(paise(money(row.getCell(8))), paise(r.amount));
    assert.equal(text(row.getCell(7)), r.note ?? '');
  }
  assert.equal(text(byId.get(15).getCell(5)), 'Unclassified');
  assert.equal(text(byId.get(15).getCell(6)), 'Left out (unclassified)');
  assert.equal(text(byId.get(15).getCell(4)), 'Credit (money in)');
  assert.equal(text(byId.get(15).getCell(3)), 'Kumar');
  assert.equal(text(byId.get(20).getCell(5)), 'Expense');
  assert.equal(text(byId.get(20).getCell(6)), 'Expense');
  assert.equal(text(byId.get(20).getCell(4)), 'Debit (money out)');
  assert.equal(text(byId.get(22).getCell(6)), 'Other income');
  assert.equal(text(byId.get(14).getCell(6)), 'Not in profit & loss');
  const credits = cf.receipts.flatMap((l) => l.records).filter((r) => r.type === 'RECORD_AMOUNT');
  const debits = cf.payments.flatMap((l) => l.records).filter((r) => r.type === 'RECORD_AMOUNT');
  assert.equal(paise(money(rowLabelled(ws, 'Total credits').getCell(8))), credits.reduce((a, r) => a + paise(r.amount), 0));
  assert.equal(paise(money(rowLabelled(ws, 'Total debits').getCell(8))), debits.reduce((a, r) => a + paise(r.amount), 0));
  assert.equal(paise(money(rowLabelled(ws, 'Total credits').getCell(8))), paise(144424.5 + 50000 + 10000.33 + 2400));
});

test('Bad debts: written off and recovered rows with totals; None when empty', async () => {
  const report = build(2025, 'FY');
  const ws = (await workbookOf(report)).getWorksheet('Bad debts');
  const off = report.profitAndLoss.expenses.find((l) => l.key === 'badDebtWrittenOff');
  const rec = report.profitAndLoss.income.find((l) => l.key === 'badDebtRecovered');
  assert.equal(off.records.length, 1);
  assert.equal(rec.records.length, 1);
  assert.equal(paise(money(rowLabelled(ws, 'Total written off').getCell(5))), paise(off.total));
  assert.equal(paise(money(rowLabelled(ws, 'Total recovered').getCell(5))), paise(rec.total));
  const loanRows = [];
  ws.eachRow((row) => { if (row.getCell(1).value instanceof Date) loanRows.push(row); });
  assert.equal(loanRows.length, 2);
  assert.equal(loanRows[0].getCell(2).value, 6);
  assert.equal(paise(money(loanRows[0].getCell(6))), 0, 'outstanding now');

  const none = (await workbookOf(build(2025, 'Q1', 'loans'))).getWorksheet('Bad debts');
  assert.equal(text(none.getRow(4).getCell(1)), 'None in this period.');
});

test('Ledger: every ledger row behind the cash flow; in, out and transfer totals equal the report', async () => {
  for (const [label, make] of REPORTS) {
    const report = make();
    const ws = (await workbookOf(report)).getWorksheet('Ledger');
    const cf = report.cashFlow;
    const records = [...cf.receipts, ...cf.payments, ...(cf.transfers ? [cf.transfers] : [])].flatMap((l) => l.records);
    if (!records.length) {
      assert.equal(text(ws.getRow(4).getCell(1)), 'None in this period.');
      continue;
    }
    const rows = dataRows(ws, 'Total');
    assert.equal(rows.length, records.length, `${label}: one row per ledger entry`);
    assert.deepEqual(new Set(rows.map((r) => r.getCell(2).value)), new Set(records.map((r) => r.id)), `${label}: the same entries`);
    const total = rowLabelled(ws, 'Total');
    assert.equal(paise(money(total.getCell(8))), paise(cf.totalReceipts.total), `${label}: in`);
    assert.equal(paise(money(total.getCell(9))), paise(cf.totalPayments.total), `${label}: out`);
    if (cf.transfers) assert.equal(paise(money(total.getCell(10))), paise(cf.transfers.total), `${label}: transfers`);
    // Column sums of the rows equal the totals too.
    const sum = (c) => rows.reduce((a, row) => a + (typeof row.getCell(c).value === 'number' ? paise(row.getCell(c).value) : 0), 0);
    assert.equal(sum(8), paise(cf.totalReceipts.total));
    assert.equal(sum(9), paise(cf.totalPayments.total));
    for (const row of rows) assert.ok(row.getCell(1).value instanceof Date, `${label}: date cell`);
  }
  const ws = (await workbookOf(build(2025, 'FY'))).getWorksheet('Ledger');
  const byId = new Map(dataRows(ws, 'Total').map((row) => [row.getCell(2).value, row]));
  assert.equal(text(byId.get(16).getCell(5)), 'Ravi → Kumar', 'a transfer names both partners');
  assert.equal(text(byId.get(16).getCell(3)), 'Partner transfer');
  assert.equal(text(byId.get(17).getCell(5)), 'Unassigned');
  assert.equal(text(byId.get(15).getCell(4)), 'Unclassified');
  assert.equal(text(byId.get(14).getCell(4)), 'Opening balance');
  assert.equal(text(byId.get(25).getCell(7)), 'Collections (older entries)');
  assert.equal(paise(money(byId.get(10).getCell(9))), paise(209700));
});

test('partner names in Chits / Loans scope come from the partners passed in', async () => {
  const report = build(2025, 'FY', 'loans');
  assert.equal(report.cashFlow.partners.length, 0);
  const ws = (await workbookOf(report)).getWorksheet('Ledger');
  const byId = new Map(dataRows(ws, 'Total').map((row) => [row.getCell(2).value, row]));
  assert.equal(text(byId.get(10).getCell(5)), 'Ravi');
  const unnamed = (await workbookOf(report, { partners: undefined })).getWorksheet('Ledger');
  const row = dataRows(unnamed, 'Total').find((r) => r.getCell(2).value === 10);
  assert.equal(text(row.getCell(5)), 'Partner #1');
});

test('an empty period gives a valid workbook (not started, and a year with no records)', async () => {
  for (const report of [build(2026, 'Q4', 'all'), build(2023, 'FY', 'all', { transactions: [], loans: [], chitFunds: [], partners })]) {
    const wb = await workbookOf(report);
    assert.deepEqual(wb.worksheets.map((ws) => ws.name), X.itrExportSheetNames('all'));
    const summary = wb.getWorksheet('Summary');
    assert.equal(money(rowLabelled(summary, 'Net profit').getCell(2)), 0);
    for (const name of ['Chit payouts', 'Manual entries', 'Bad debts', 'Ledger']) {
      assert.equal(text(wb.getWorksheet(name).getRow(4).getCell(1)), 'None in this period.', `${report.period.label}: ${name}`);
    }
    const pl = wb.getWorksheet('Profit & loss');
    assert.equal(money(rowLabelled(pl, 'Net profit').getCell(2 + report.months.length)), 0);
  }
});

test('formatting: money is numeric with the Indian format, dates are dates, headers bold and frozen, wide sheets landscape', async () => {
  const report = build(2025, 'FY');
  const wb = await workbookOf(report);
  let moneyCells = 0;
  let dateCells = 0;
  for (const ws of wb.worksheets) {
    ws.eachRow((row) => row.eachCell((cell) => {
      if (isMoneyFormat(cell.numFmt)) {
        assert.equal(typeof cell.value, 'number', `${ws.name} ${cell.address}: money is a number`);
        assert.ok(!Object.is(cell.value, -0), `${ws.name} ${cell.address}: no -0`);
        moneyCells++;
      }
      if (cell.value instanceof Date) {
        assert.ok(/d/.test(cell.numFmt), `${ws.name} ${cell.address}: date format`);
        dateCells++;
      }
      assert.ok(typeof cell.value !== 'string' || !/^-?[\d,]+\.\d\d$/.test(cell.value), `${ws.name} ${cell.address}: no money written as text`);
    }));
  }
  assert.ok(moneyCells > 200, `${moneyCells} money cells`);
  assert.ok(dateCells > 20, `${dateCells} date cells`);

  for (const name of ['Profit & loss', 'Cash flow', 'Chit payouts', 'Loan income', 'Manual entries', 'Bad debts', 'Ledger']) {
    const ws = wb.getWorksheet(name);
    const view = ws.views[0];
    assert.equal(view.state, 'frozen', `${name}: frozen`);
    assert.equal(view.ySplit, 3, `${name}: header row frozen`);
    assert.equal(ws.pageSetup.orientation, 'landscape', `${name}: landscape`);
    assert.equal(ws.getRow(3).getCell(1).font.bold, true, `${name}: bold header`);
    assert.ok(ws.getColumn(1).width >= 10, `${name}: column width`);
  }
  assert.equal(wb.getWorksheet('Profit & loss').views[0].xSplit, 1, 'line names stay in view');
  assert.equal(rowLabelled(wb.getWorksheet('Profit & loss'), 'Net profit').getCell(1).font.bold, true, 'totals bold');

  // In the file the lakh commas are escaped literals, as Excel needs them.
  const buffer = await X.buildItrReportXlsx(report, { generatedAt: GENERATED, unclassifiedCount: 0 });
  const styles = await (await require('jszip').loadAsync(buffer)).file('xl/styles.xml').async('string');
  assert.ok(styles.includes('formatCode="##\\,##\\,##0.00;-##\\,##\\,##0.00"'), 'lakh format written as is');

  // The number format shows Indian grouping and keeps the sign (xlsx's SSF follows Excel's rules).
  const SSF = require('xlsx').SSF;
  const shown = (v) => SSF.format(X.moneyFormat(v), v);
  const cases = [[0, '0.00'], [-5, '-5.00'], [9600, '9,600.00'], [-84260, '-84,260.00'], [99999.99, '99,999.99'], [100000, '1,00,000.00'],
    [144424.5, '1,44,424.50'], [-121678.04, '-1,21,678.04'], [9999999.99, '99,99,999.99'], [10000000, '1,00,00,000.00'],
    [39562484.64, '3,95,62,484.64'], [-39562484.64, '-3,95,62,484.64']];
  for (const [v, text] of cases) assert.equal(shown(v), text, String(v));
});

test('Notes: the rules for the accountant, and the scope notes', async () => {
  const wb = await workbookOf(build(2025, 'FY', 'chits'));
  const notes = [];
  wb.getWorksheet('Notes').eachRow((row) => notes.push(text(row.getCell(2))));
  const all = notes.join('\n');
  for (const phrase of [/full-term contribution .*− the payout/, /recognised on the payout date/, /Weekly loans: only after the principal is fully collected/, /Reducing Balance loans: the interest portion/,
    /kept back from the loan/, /disbursement date/, /marked non-recoverable/, /shared equally between the partners/, /partner transfers move cash between partners and do not change the total/i,
    /Indian financial year/, /IST/, /Unclassified manual entries are excluded from profit/, /not a tax computation/, /Shared expenses and other income are not allocated to Chits/]) {
    assert.match(all, phrase);
  }
});

test('the builder does not change the report', async () => {
  const report = build(2025, 'FY');
  const before = JSON.stringify(report);
  await workbookOf(report);
  assert.equal(JSON.stringify(report), before);
});
