// Run with: node tests/test-itr-report-route.js. No database connection or writes.
// GET /api/reports/itr through the real loader (lib/itrReportData.ts) against an in-memory
// Prisma stand-in: authentication, parameter validation and defaults, owner scoping, the
// records-free first response and the one-line records read. Also the Tax report nav entry,
// and GET /api/reports/itr/export (the Excel file): auth, parameters, headers, file name and
// that the file holds the same report.
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', jsx: 'react-jsx' });
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');

const stubModule = (request, exports) => {
  const resolved = require.resolve(request);
  const stub = new Module(resolved);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
};

// ---------------------------------------------------------------------------
// In-memory data: owner 1 (the account under test) and owner 2 (must never leak in)
// ---------------------------------------------------------------------------

const d = (s) => new Date(`${s}T00:00:00Z`);
let nextId = 1;
const tx = (createdById, date, type, amount, fields = {}) => ({
  id: nextId++, createdById, date: d(date), type, amount, note: null, category: null, from_partner_id: null, to_partner_id: null, ...fields,
});

const transactions = [
  tx(1, '2024-12-01', 'LOAN_DISBURSEMENT', 5000, { from_partner_id: 1, note: 'Early loan' }),
  tx(1, '2025-06-30', 'RECORD_AMOUNT', 100000, { to_partner_id: 1, note: 'Old amount reset' }), // unclassified
  tx(1, '2025-07-10', 'LOAN_DISBURSEMENT', 9700, { from_partner_id: 1 }),
  tx(1, '2025-08-05', 'LOAN_REPAYMENT', 1500, { to_partner_id: 2 }),
  tx(1, '2025-08-05', 'DOCUMENT_CHARGE', 300, { to_partner_id: 1 }),
  tx(1, '2025-09-01', 'CHIT_CONTRIBUTION', 5000, { to_partner_id: 1 }),
  tx(1, '2025-10-10', 'AUCTION_PAYOUT', 40000, { from_partner_id: 2 }),
  tx(1, '2026-01-10', 'PARTNER_TO_PARTNER', 2000, { from_partner_id: 1, to_partner_id: 2 }),
  tx(1, '2026-02-01', 'RECORD_AMOUNT', 1200, { from_partner_id: 2, note: 'Office tea', category: 'EXPENSE' }),
  tx(1, '2026-05-01', 'RECORD_AMOUNT', 2400, { to_partner_id: 1, note: 'Car rent', category: 'OTHER_INCOME' }),
  tx(1, '2026-05-02', 'RECORD_AMOUNT', 50, { from_partner_id: 1, note: 'Misc', category: 'OTHER_INCOME' }), // misfit: unclassified
  tx(1, '2026-05-03', 'RECORD_AMOUNT', 10, { note: 'No partner' }), // moves no cash
  tx(2, '2023-01-01', 'LOAN_DISBURSEMENT', 1, { from_partner_id: 3 }),
  tx(2, '2025-07-01', 'RECORD_AMOUNT', 999999, { to_partner_id: 3, category: 'OTHER_INCOME', note: 'Other account' }),
  tx(2, '2025-07-02', 'RECORD_AMOUNT', 5, { to_partner_id: 3, note: 'Other account, unclassified' }),
];

const loans = [
  { id: 1, createdById: 1, amount: 10000, interestRate: 500, interestPercentage: null, documentCharge: 300, repaymentType: 'Monthly', loanType: 'Monthly',
    disbursementDate: d('2025-07-10'), status: 'Active', nonRecoverableAt: null, recoveryPrincipalAtMark: null, remainingAmount: 9000,
    borrower: { name: 'Mani' }, repayments: [{ id: 101, amount: 1500, paidDate: d('2025-08-05'), period: 1, paymentType: 'full', principalComponent: null, interestComponent: null }] },
  { id: 9, createdById: 2, amount: 50000, interestRate: 5000, interestPercentage: null, documentCharge: 9999, repaymentType: 'Monthly', loanType: 'Monthly',
    disbursementDate: d('2025-07-10'), status: 'Active', nonRecoverableAt: null, recoveryPrincipalAtMark: null, remainingAmount: 0,
    borrower: { name: 'Other' }, repayments: [{ id: 901, amount: 10000, paidDate: d('2025-08-05'), period: 1, paymentType: 'full', principalComponent: null, interestComponent: null }] },
];

const chitFunds = [
  { id: 1, createdById: 1, name: 'Gold', monthlyContribution: 5000, firstMonthContribution: null, duration: 10, chitFundType: 'Fixed',
    auctions: [{ id: 11, amount: 40000, date: d('2025-10-10'), month: 1, winner: { globalMember: { name: 'Asha' } } }] },
  { id: 2, createdById: 2, name: 'Other fund', monthlyContribution: 100000, firstMonthContribution: null, duration: 10, chitFundType: 'Fixed',
    auctions: [{ id: 21, amount: 1, date: d('2025-10-10'), month: 1, winner: null }] },
];

const partners = [
  { id: 2, name: 'Kumar', createdById: 1, isActive: true },
  { id: 1, name: 'Ravi', createdById: 1, isActive: true },
  { id: 4, name: 'Gone', createdById: 1, isActive: false },
  { id: 3, name: 'Other', createdById: 2, isActive: true },
];

// ---------------------------------------------------------------------------
// Prisma stand-in: just the where clauses lib/itrReportData.ts uses; every call is logged
// ---------------------------------------------------------------------------

const calls = [];
const inRange = (value, cond) => {
  if (!cond) return true;
  if (cond instanceof Date) return value.getTime() === cond.getTime();
  if (cond.gte && !(value >= cond.gte)) return false;
  if (cond.lt && !(value < cond.lt)) return false;
  return true;
};
const ownerOf = (where) => where.createdById ?? where.chitFund?.createdById;
const minOf = (rows, field) => (rows.length ? new Date(Math.min(...rows.map((r) => r[field].getTime()))) : null);
const clone = (x) => JSON.parse(JSON.stringify(x), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v));

const prisma = {
  transaction: {
    async findMany({ where }) {
      calls.push({ model: 'transaction.findMany', where });
      return transactions.filter((t) => t.createdById === where.createdById && (!where.type || t.type === where.type) && inRange(t.date, where.date)).map(clone);
    },
    async aggregate({ where }) {
      calls.push({ model: 'transaction.aggregate', where });
      return { _min: { date: minOf(transactions.filter((t) => t.createdById === where.createdById), 'date') } };
    },
  },
  loan: {
    async findMany({ where, select }) {
      calls.push({ model: 'loan.findMany', where });
      const lt = select.repayments.where.paidDate.lt;
      return loans.filter((l) => l.createdById === where.createdById).map((l) => ({ ...clone(l), repayments: clone(l.repayments).filter((r) => r.paidDate < lt) }));
    },
    async aggregate({ where }) {
      calls.push({ model: 'loan.aggregate', where });
      return { _min: { disbursementDate: minOf(loans.filter((l) => l.createdById === where.createdById), 'disbursementDate') } };
    },
  },
  chitFund: {
    async findMany({ where, select }) {
      calls.push({ model: 'chitFund.findMany', where });
      return chitFunds.filter((f) => f.createdById === where.createdById).map((f) => ({ ...clone(f), auctions: clone(f.auctions).filter((a) => inRange(a.date, select.auctions.where.date)) }));
    },
  },
  auction: {
    async aggregate({ where }) {
      calls.push({ model: 'auction.aggregate', where });
      const auctions = chitFunds.filter((f) => f.createdById === where.chitFund.createdById).flatMap((f) => f.auctions);
      return { _min: { date: minOf(auctions, 'date') } };
    },
  },
  partner: {
    async findMany({ where }) {
      calls.push({ model: 'partner.findMany', where });
      return partners.filter((p) => p.createdById === where.createdById && (where.isActive === undefined || p.isActive === where.isActive)).sort((a, b) => a.id - b.id).map(clone);
    },
  },
};

let currentUser = 1;
stubModule('../lib/prisma', { default: prisma, __esModule: true });
stubModule('../lib/auth', { getCurrentUserId: async () => currentUser });
// JSON answers as { body, status }; a file answer (new NextResponse) keeps its bytes and headers.
class NextResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  }
  static json(body, init) {
    return { body, status: init?.status ?? 200 };
  }
}
stubModule('next/server', { NextResponse });

const route = require('../app/api/reports/itr/route');
const exportRoute = require('../app/api/reports/itr/export/route');
const { buildItrReport } = require('../lib/itrReport');
const { toItrReportView, findItrLine } = require('../lib/itrReportView');
const fp = require('../lib/fiscalPeriods');

const get = async (query = '') => {
  calls.length = 0;
  return route.GET({ url: `http://x/api/reports/itr${query ? `?${query}` : ''}` });
};

/** Owner 1's full input, unfiltered by date: what the report must equal. */
const ownerInput = (owner) => ({
  transactions: transactions.filter((t) => t.createdById === owner).map(clone),
  loans: loans.filter((l) => l.createdById === owner).map(clone),
  chitFunds: chitFunds.filter((f) => f.createdById === owner).map(clone),
  partners: partners.filter((p) => p.createdById === owner && p.isActive).sort((a, b) => a.id - b.id).map(({ id, name }) => ({ id, name })),
});

// ---------------------------------------------------------------------------

test('401 without a session', async () => {
  currentUser = null;
  try {
    const res = await get('fy=2025');
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, 'nothing is read');
  } finally {
    currentUser = 1;
  }
});

test('400 on bad parameters', async () => {
  for (const query of ['fy=abc', 'fy=25', 'fy=1999', 'fy=2025.5', 'period=Q5', 'period=year', 'scope=everything', 'section=pl', 'line=chitMargin', 'section=bad&line=chitMargin', 'section=pl&line=']) {
    const res = await get(query);
    assert.equal(res.status, 400, query);
    assert.ok(res.body.error, query);
    assert.equal(calls.length, 0, `${query}: nothing is read`);
  }
});

test('defaults: current fiscal year, full year, all', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  const { period } = res.body.report;
  assert.equal(period.fy, fp.fiscalYearOf(new Date()));
  assert.equal(period.period, 'FY');
  assert.equal(period.scope, 'all');
  assert.equal(period.status, 'running');
  // Same as asking for them; values are case-insensitive.
  const explicit = await get(`fy=${period.fy}&period=fy&scope=ALL`);
  assert.deepEqual(explicit.body.report.period, period);
});

test('fiscal years from the earliest record of this owner, newest first, with labels', async () => {
  const res = await get('fy=2025');
  const current = fp.fiscalYearOf(new Date());
  const years = res.body.fiscalYears;
  assert.equal(years[0].fy, current);
  assert.equal(years[0].running, true);
  assert.equal(years.at(-1).fy, 2024, "owner 2's 2023 entry does not add FY 2022-23");
  assert.deepEqual(years.map((y) => y.fy), Array.from({ length: current - 2024 + 1 }, (_, i) => current - i));
  const fy25 = years.find((y) => y.fy === 2025);
  assert.deepEqual(fy25, { fy: 2025, label: 'FY 2025-26', filingYearLabel: 'AY 2026-27', running: false });
});

test('owner scoping: every read is the owner\'s; nothing of another account reaches the figures', async () => {
  const res = await get('fy=2025');
  assert.equal(res.status, 200);
  assert.ok(calls.length >= 7);
  for (const call of calls) assert.equal(ownerOf(call.where), 1, `${call.model} is scoped to the owner`);
  assert.deepEqual(calls.find((c) => c.model === 'partner.findMany').where, { createdById: 1, isActive: true });

  const pl = res.body.report.profitAndLoss;
  const line = (lines, key) => lines.find((l) => l.key === key);
  assert.equal(line(pl.income, 'chitMargin').total, 10000);
  assert.equal(line(pl.income, 'loanInterest:monthly').total, 500);
  assert.equal(line(pl.income, 'documentCharges').total, 300);
  assert.equal(line(pl.income, 'otherIncome').total, 0, "owner 2's other income stays out");
  assert.equal(line(pl.expenses, 'expenses').total, 1200);
  assert.equal(pl.netProfit.total, 9600);
  assert.deepEqual(res.body.report.partnerShare.partners, [{ partnerId: 1, name: 'Ravi', share: 4800 }, { partnerId: 2, name: 'Kumar', share: 4800 }]);
  assert.equal(res.body.report.cashFlow.opening, -5000, 'opening: the 1 Dec 2024 loan only');
  assert.equal(res.body.report.cashFlow.closing, -5000 + 100000 - 9700 + 1500 + 300 + 5000 - 40000 - 1200);

  currentUser = 2;
  try {
    const other = await get('fy=2025');
    for (const call of calls) assert.equal(ownerOf(call.where), 2);
    assert.equal(other.body.report.profitAndLoss.income.find((l) => l.key === 'otherIncome').total, 999999);
    assert.equal(other.body.unclassifiedCount, 1);
  } finally {
    currentUser = 1;
  }
});

test('the response is buildItrReport of the owner\'s rows, without records; the loader\'s date filters change nothing', async () => {
  for (const [fy, period, scope] of [[2025, 'FY', 'all'], [2025, 'H2', 'all'], [2025, 'Q2', 'chits'], [2025, 'FY', 'loans'], [2024, 'FY', 'all']]) {
    const res = await get(`fy=${fy}&period=${period}&scope=${scope}`);
    assert.equal(res.status, 200);
    const expected = toItrReportView(buildItrReport(ownerInput(1), { fy, period, scope, asOf: new Date() }));
    assert.deepEqual(res.body.report, expected, `${fy} ${period} ${scope}`);
    const json = JSON.stringify(res.body.report);
    assert.ok(!json.includes('"records"'), 'no records in the first response');
  }
  const res = await get('fy=2025');
  const repayments = res.body.report.cashFlow.receipts.find((l) => l.key === 'loanRepayments');
  assert.equal(repayments.recordCount, 1);
  const unclassified = res.body.report.warnings.find((w) => w.code === 'UNCLASSIFIED_ENTRIES');
  assert.equal(unclassified.count, 1, 'the 30 Jun 2025 entry; the 2 May 2026 misfit is in the next year');
  assert.equal(unclassified.recordCount, 1);
  const docs = res.body.report.warnings.find((w) => w.code === 'DOCUMENT_CHARGE_LEDGER');
  assert.equal(docs.recordCount, 1);
  assert.equal('records' in docs, false);
});

test('scope reads: Chits skips loans, Loans skips chit funds, pooled scopes read only the period\'s ledger rows', async () => {
  await get('fy=2025&scope=chits');
  assert.ok(!calls.some((c) => c.model === 'loan.findMany'));
  const chitTx = calls.find((c) => c.model === 'transaction.findMany' && c.where.date);
  assert.equal(chitTx.where.date.gte.toISOString(), fp.fiscalPeriodRange(2025, 'FY').start.toISOString());
  assert.equal(chitTx.where.date.lt.toISOString(), fp.fiscalPeriodRange(2025, 'FY').endExclusive.toISOString());
  await get('fy=2025&scope=loans');
  assert.ok(!calls.some((c) => c.model === 'chitFund.findMany'));
  await get('fy=2025');
  const allTx = calls.find((c) => c.model === 'transaction.findMany' && c.where.date);
  assert.equal(allTx.where.date.gte, undefined, 'All reads earlier rows for the opening balance');
  // A running period stops at the as-of day.
  await get(`fy=${fp.fiscalYearOf(new Date())}`);
  const runningTx = calls.find((c) => c.model === 'transaction.findMany' && c.where.date);
  assert.equal(runningTx.where.date.lt.toISOString(), fp.istNextDayStart(new Date()).toISOString());
});

test('unclassified count: every date, misfit categories included, no-partner entries skipped', async () => {
  const res = await get('fy=2025');
  assert.equal(res.body.unclassifiedCount, 2);
});

test('one line\'s records (section + line)', async () => {
  const full = buildItrReport(ownerInput(1), { fy: 2025, period: 'FY', scope: 'all', asOf: new Date() });
  let res = await get('fy=2025&section=cash&line=loanRepayments');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.line, findItrLine(full, 'cash', 'loanRepayments'));
  assert.equal(res.body.line.records.length, 1);
  assert.equal(res.body.line.records[0].kind, 'ledger');
  assert.equal(res.body.fiscalYears, undefined, 'a line read sends the line only');

  // P&L and cash flow both have a documentCharges line: the section tells them apart.
  const pl = (await get('fy=2025&section=pl&line=documentCharges')).body.line;
  const cash = (await get('fy=2025&section=cash&line=documentCharges')).body.line;
  assert.equal(pl.records[0].kind, 'documentCharge');
  assert.equal(cash.records[0].kind, 'ledger');

  res = await get('fy=2025&section=cash&line=partnerTransfers');
  assert.equal(res.body.line.records.length, 1);
  assert.equal(res.body.line.total, 2000);

  res = await get('fy=2025&section=warning&line=DOCUMENT_CHARGE_LEDGER');
  assert.equal(res.body.line.records.length, 1);

  res = await get('fy=2026&section=pl&line=chitMargin&scope=loans');
  assert.equal(res.status, 404, 'Loans scope has no chit margin line');
  res = await get('fy=2025&section=pl&line=nope');
  assert.equal(res.status, 404);
});

test('nav: Tax report sits in Money, has its route and crumb, and is not on the phone bar', () => {
  const nav = require('../components/kit/app-shell/nav-config');
  const money = nav.NAV_GROUPS.find((g) => g.id === 'money');
  const item = money.items.find((i) => i.href === '/reports/itr');
  assert.ok(item);
  assert.equal(item.label, 'Tax report');
  assert.equal(item.bottomBar, undefined);
  assert.equal(nav.BOTTOM_BAR_ITEMS.length, 4, 'the phone bar keeps its four slots (More is the fifth)');
  assert.equal(nav.getActiveNavItem('/reports/itr').id, item.id);
  assert.deepEqual(nav.getBreadcrumbs('/reports/itr').map((c) => [c.label, c.href]), [['Tax report', '/reports/itr']]);
  assert.equal(nav.getRouteLayout('/reports/itr'), 'page');
  assert.equal(new Set(nav.NAV_ITEMS.map((i) => i.id)).size, nav.NAV_ITEMS.length, 'nav ids are unique');
});

// ---------------------------------------------------------------------------
// GET /api/reports/itr/export
// ---------------------------------------------------------------------------

const ExcelJS = require('exceljs');
const { itrExportSheetNames } = require('../lib/itrReportExcel');

const getExport = async (query = '') => {
  calls.length = 0;
  return exportRoute.GET({ url: `http://x/api/reports/itr/export${query ? `?${query}` : ''}` });
};
const readWorkbook = async (res) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(res.body));
  return wb;
};
const summaryValue = (wb, label) => {
  let value;
  wb.getWorksheet('Summary').eachRow((row) => {
    if (String(row.getCell(1).value ?? '').trim() === label) value = row.getCell(2).value;
  });
  return value;
};

test('export: 401 without a session, nothing read', async () => {
  currentUser = null;
  try {
    const res = await getExport('fy=2025');
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  } finally {
    currentUser = 1;
  }
});

test('export: 400 on the same bad parameters as the report, nothing read', async () => {
  for (const query of ['fy=abc', 'fy=25', 'fy=1999', 'fy=2025.5', 'period=Q5', 'period=year', 'scope=everything']) {
    const [report, file] = [await route.GET({ url: `http://x/api/reports/itr?${query}` }), await getExport(query)];
    assert.equal(file.status, 400, query);
    assert.equal(file.body.error, report.body.error, `${query}: same message as the report route`);
    assert.equal(calls.length, 0, `${query}: nothing is read`);
  }
});

test('export: an .xlsx with a descriptive file name, per period and scope', async () => {
  for (const [query, name] of [
    ['fy=2025&period=Q1&scope=all', 'tax-report-FY2025-26-Q1-all.xlsx'],
    ['fy=2025', 'tax-report-FY2025-26-all.xlsx'],
    ['fy=2025&period=h2&scope=LOANS', 'tax-report-FY2025-26-H2-loans.xlsx'],
    ['fy=2024&scope=chits', 'tax-report-FY2024-25-chits.xlsx'],
  ]) {
    const res = await getExport(query);
    assert.equal(res.status, 200, query);
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${name}"`, query);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(res.body);
    assert.equal(bytes.subarray(0, 2).toString(), 'PK', `${query}: a zip (xlsx) file`);
    const wb = await readWorkbook(res);
    const scope = /scope=(\w+)/i.exec(query)?.[1].toLowerCase() ?? 'all';
    assert.deepEqual(wb.worksheets.map((ws) => ws.name), itrExportSheetNames(scope), query);
  }
  // Defaults: the current fiscal year (running, so the name carries today's IST date), FY, all.
  const res = await getExport();
  const fy = fp.fiscalYearOf(new Date());
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="tax-report-${fp.fiscalYearLabel(fy).replace(' ', '')}-all-to-${fp.istDayKey(new Date())}.xlsx"`);
});

test('export: the file holds buildItrReport of the owner\'s rows (the same figures as the page), owner-scoped', async () => {
  for (const [fy, period, scope] of [[2025, 'FY', 'all'], [2025, 'Q2', 'all'], [2025, 'FY', 'loans'], [2025, 'FY', 'chits']]) {
    const res = await getExport(`fy=${fy}&period=${period}&scope=${scope}`);
    for (const call of calls) assert.equal(ownerOf(call.where), 1, `${call.model} is scoped to the owner`);
    const expected = buildItrReport(ownerInput(1), { fy, period, scope, asOf: new Date() });
    const page = (await get(`fy=${fy}&period=${period}&scope=${scope}`)).body.report;
    const wb = await readWorkbook(res);
    const netLabel = scope === 'all' ? 'Net profit' : `Net profit (${scope === 'chits' ? 'Chits' : 'Loans'}, before shared items)`;
    assert.equal(summaryValue(wb, netLabel), expected.profitAndLoss.netProfit.total, `${fy} ${period} ${scope}: net profit`);
    assert.equal(summaryValue(wb, netLabel), page.profitAndLoss.netProfit.total, 'equals the page');
    assert.equal(summaryValue(wb, 'Net cash movement'), page.cashFlow.netMovement.total);
    if (scope === 'all') {
      assert.equal(summaryValue(wb, 'Closing cash'), page.cashFlow.closing, 'closing cash equals the page');
      assert.equal(summaryValue(wb, 'Ravi'), page.partnerShare.partners.find((p) => p.name === 'Ravi').share);
      assert.equal(summaryValue(wb, 'Entries to classify (any date)'), 2, 'the unclassified count of every date');
    }
  }
  // Another account's export holds only its own figures.
  currentUser = 2;
  try {
    const res = await getExport('fy=2025');
    for (const call of calls) assert.equal(ownerOf(call.where), 2);
    const wb = await readWorkbook(res);
    let otherIncome; // P&L lines are indented under their heading
    wb.getWorksheet('Summary').eachRow((row) => { if (row.getCell(1).value === '   Other income') otherIncome = row.getCell(2).value; });
    assert.equal(otherIncome, 999999);
  } finally {
    currentUser = 1;
  }
});

test('export: a failure answers 500 with a generic message', async () => {
  const original = prisma.partner.findMany;
  prisma.partner.findMany = async () => { throw new Error('db down: secret detail'); };
  const error = console.error;
  console.error = () => {};
  try {
    const res = await getExport('fy=2025');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Failed to export the tax report');
  } finally {
    prisma.partner.findMany = original;
    console.error = error;
  }
});
