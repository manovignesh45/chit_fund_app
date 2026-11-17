// node tests/test-member-insights.js [--integration]
// Member 360: lib/memberInsights.ts buildMemberSummary, lib/memberTimeline.ts and the
// members route `summary` / `timeline` actions.
// Integration mode only reads the disposable seeded database on port 55439 (ui_baseline, or
// MEMBER_INSIGHTS_DB=<name> on the same server). It never uses the application DATABASE_URL.
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', jsx: 'react-jsx' });
const integration = process.argv.includes('--integration');
if (integration) {
  const db = process.env.MEMBER_INSIGHTS_DB || 'ui_baseline';
  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(require('node:os').userInfo().username)}@localhost:55439/${db}?host=/tmp/chit-recovery-pg-socket`;
  // Prisma fills unset variables from the real microfinance-app/.env; pin mail/scheduler ones to inert values.
  for (const [k, v] of Object.entries({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '9', SMTP_USER: 'x', SMTP_PASS: 'x',
    SMTP_FROM: 'test@example.invalid', DEFAULT_EMAIL_RECIPIENTS: 'test@example.invalid', AUTO_MONTHLY_EMAIL_ENABLED: 'false',
    AUTO_WEEKLY_EMAIL_ENABLED: 'false', EMAIL_RECOVERY_ENABLED: 'false', AUTO_MONTHLY_DB_BACKUP_ENABLED: 'false', START_BACKUP_DB: 'false' })) {
    process.env[k] = v;
  }
}
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { Prisma } = require('@prisma/client');
const { buildMemberSummary, fundCurrentMonth } = require('../lib/memberInsights');
const { calculateLoanProfit, calculateTotalLoanProfit, calculateChitFundProfitUpToCurrentMonth } = require('../lib/financialUtils');

const now = new Date('2026-11-17T12:00:00');
const day = (s) => new Date(`${s}T10:00:00`);

// Fixed fund: a winner pays the term contribution, firstMonthContribution + 9 × monthly = 49,000.
const fixed = { id: 1, name: 'Fixed 50K', status: 'Active', totalAmount: 50000, monthlyContribution: 5000, firstMonthContribution: 4000,
  membersCount: 10, chitFundType: 'Fixed', currentMonth: 3, startDate: day('2026-09-01'), duration: 10 };
const auctionFund = { id: 2, name: 'Auction 50K', status: 'Active', totalAmount: 50000, monthlyContribution: 2500, firstMonthContribution: null,
  membersCount: 20, chitFundType: 'Auction', currentMonth: 4, startDate: day('2026-08-01'), duration: 20 };

const memberships = [
  // A: won month 1 of the Fixed fund → commission (4,000 + 9 × 5,000) − 45,000 = 4,000
  { id: 11, joinDate: day('2026-08-25'), chitFund: fixed,
    contributions: [{ amount: 4000, month: 1, paidDate: day('2026-09-02') }, { amount: 5000, month: 2, paidDate: day('2026-10-02') }],
    auctions: [{ id: 101, month: 1, date: day('2026-09-05'), amount: 45000 }] },
  // B: never won; one month paid in two parts
  { id: 12, joinDate: day('2026-07-20'), chitFund: auctionFund,
    contributions: [{ amount: 2000, month: 1, paidDate: day('2026-08-02') }, { amount: 500, month: 1, paidDate: day('2026-08-09') }], auctions: [] },
  // C: second Fixed ticket, won month 5 (after currentMonth 3) → not counted
  { id: 13, joinDate: day('2026-08-25'), chitFund: fixed, contributions: [],
    auctions: [{ id: 102, month: 5, date: day('2026-11-01'), amount: 40000 }] },
  // D: won month 2 of the Auction fund but dated in the future → not counted
  { id: 14, joinDate: day('2026-07-20'), chitFund: auctionFund, contributions: [],
    auctions: [{ id: 103, month: 2, date: day('2026-12-01'), amount: 42000 }] },
];

const reducing = { id: 21, loanType: 'Reducing Balance', repaymentType: 'Reducing Balance', status: 'Completed', disbursementDate: day('2026-08-01'),
  amount: 12000, interestRate: 0, interestPercentage: 12, documentCharge: 200, remainingAmount: 0,
  repayments: [
    { amount: 6000, paymentType: 'full', paidDate: day('2026-09-01'), period: 1 },
    { amount: 6181.2, paymentType: 'full', paidDate: day('2026-10-01'), period: 2 },
  ] };
const recovered = { id: 22, loanType: 'Monthly', repaymentType: 'Monthly', status: 'Non-Recoverable', disbursementDate: day('2026-06-01'),
  amount: 10000, interestRate: 500, interestPercentage: null, documentCharge: 100, remainingAmount: 5500,
  nonRecoverableAt: day('2026-09-15'), nonRecoverableReason: 'Moved away', recoveryPrincipalAtMark: 8000, recoveryDuesAtMark: 3000,
  recoveryInterestOutstanding: 1000, recoveryAmount: 3000, recoveryOutcome: 'Open',
  repayments: [
    { amount: 1500, paymentType: 'full', paidDate: day('2026-07-01'), period: 1 },
    { amount: 1500, paymentType: 'full', paidDate: day('2026-08-01'), period: 2 },
    { amount: 500, paymentType: 'interestOnly', paidDate: day('2026-09-01'), period: 3 },
    { amount: 3000, paymentType: 'RECOVERY', paidDate: day('2026-10-20'), period: 0, principalComponent: 2500, interestComponent: 500 },
  ] };

test('buildMemberSummary: chit commission per won auction, with the current-month and date filter', () => {
  const s = buildMemberSummary({ id: 5, createdAt: day('2026-06-01') }, memberships, [], now);
  const [a, b, c, d] = s.chits;
  assert.deepEqual(a.won, { auctionId: 101, month: 1, date: day('2026-09-05').toISOString(), payout: 45000, discount: 5000, discountPct: 10, commission: 4000, counted: true });
  assert.equal(a.commission, 4000, 'term contribution (4,000 + 9 × 5,000) − 45,000');
  assert.equal(a.contributionsPaid, 9000);
  assert.equal(a.monthsPaid, 2);
  assert.equal(b.won, null, 'never won');
  assert.equal(b.commission, 0);
  assert.equal(b.monthsPaid, 1, 'a month paid in parts counts once');
  assert.equal(b.contributionsPaid, 2500);
  assert.equal(c.won.counted, false, 'auction month 5 > currentMonth 3');
  assert.equal(c.won.commission, 0);
  assert.equal(c.commission, 0);
  assert.equal(d.won.counted, false, 'future-dated auction');
  assert.equal(d.commission, 0);
  assert.equal(s.totals.chitCommission, 4000);
  // Same answer as the fund-level formula over these auctions
  const fixedAuctions = [...memberships[0].auctions, ...memberships[2].auctions];
  assert.equal(calculateChitFundProfitUpToCurrentMonth(fixed, [], fixedAuctions), 4000);
  assert.equal(calculateChitFundProfitUpToCurrentMonth(auctionFund, [], memberships[3].auctions), 0);
  // membersCount does not enter the formula: a 1-member fund credits the same 4,000
  const solo = { ...fixed, membersCount: 1 };
  const soloSummary = buildMemberSummary({ id: 5, createdAt: day('2026-06-01') }, [{ ...memberships[0], chitFund: solo }], [], now);
  assert.equal(soloSummary.chits[0].commission, 4000);
});

test('buildMemberSummary: current month falls back to the start date like calculateChitFundProfitUpToCurrentMonth', () => {
  assert.equal(fundCurrentMonth({ ...fixed, currentMonth: 0 }, now), 3, 'Sep 1 → Nov 17 is month 3');
  assert.equal(fundCurrentMonth({ ...fixed, currentMonth: 0, startDate: day('2026-09-20') }, now), 2, 'before the start day of the month');
  assert.equal(fundCurrentMonth({ ...fixed, currentMonth: 7 }, now), 7);
});

test('buildMemberSummary: Reducing Balance and recovery loans use calculateLoanProfit', () => {
  const s = buildMemberSummary({ id: 5, createdAt: day('2026-06-01') }, [], [reducing, recovered], now);
  const [rb, rec] = s.loans;
  assert.equal(rb.profit, 381.2, '1% of 12,000 + 1% of 6,120 + 200 document charge');
  assert.equal(rb.profit, Math.round(calculateLoanProfit(reducing, reducing.repayments) * 100) / 100);
  assert.equal(rb.installmentsPaid, 2);
  assert.equal(rb.cashDisbursed, 11800);
  assert.equal(rb.recovery, null);
  assert.equal(rec.profit, 2100, '3 × 500 interest + 100 document charge + 500 recovery interest');
  assert.equal(rec.totalRepaid, 6500, 'recovery receipts are repayments');
  assert.equal(rec.installmentsPaid, 2, 'interest-only and recovery receipts do not settle a period');
  assert.equal(rec.lastRepaymentDate, day('2026-10-20').toISOString());
  assert.deepEqual(rec.recovery, { markedAt: day('2026-09-15').toISOString(), reason: 'Moved away', principalAtMark: 8000, duesAtMark: 3000,
    interestOutstanding: 1000, recovered: 3000, outcome: 'Open' });
  assert.equal(s.totals.loanProfit, 2481.2);
  assert.equal(s.totals.chitCommission, 0);
});

test('buildMemberSummary: money in / out / net and key dates', () => {
  const s = buildMemberSummary({ id: 5, createdAt: day('2026-06-01') }, memberships, [reducing, recovered], now);
  assert.deepEqual(s.totals, {
    moneyIn: 30181.2, // contributions 11,500 + repayments 18,681.2
    moneyOut: 148700, // loans (12,000 − 200) + (10,000 − 100) + payouts 45,000 + 40,000 + 42,000
    netCashFlow: -118518.8,
    profit: 6481.2,
    loanProfit: 2481.2,
    chitCommission: 4000,
    contributionsPaid: 11500,
    repaymentsReceived: 18681.2,
    loanPrincipalOut: 22000,
    auctionPayoutsOut: 127000,
    documentCharges: 300,
  });
  assert.deepEqual(s.keyDates, {
    memberSince: day('2026-06-01').toISOString(),
    firstActivity: day('2026-06-01').toISOString(), // the Monthly loan's disbursement
    lastPayment: day('2026-10-20').toISOString(),
  });
  const empty = buildMemberSummary({ id: 6, createdAt: day('2026-01-01') }, [], [], now);
  assert.equal(empty.totals.moneyIn, 0);
  assert.equal(empty.keyDates.firstActivity, null);
  assert.equal(empty.keyDates.lastPayment, null);
});

// ---- timeline with a mocked database: query shape, scoping, filters and row mapping ----
function loadTimeline(queryRaw) {
  const original = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (parent && parent.filename.endsWith('memberTimeline.ts') && request === './prisma') return { __esModule: true, default: { $queryRaw: queryRaw } };
      return original.call(this, request, parent, isMain);
    };
    const file = require.resolve('../lib/memberTimeline');
    delete require.cache[file];
    const mod = require(file);
    delete require.cache[file]; // later requires (the route, in integration mode) get the real database
    return mod;
  } finally { Module._load = original; }
}

test('timeline: params, branches per filter, owner scoping and row mapping', async () => {
  const calls = [];
  const rows = [
    { kind: 'repayment', id: 9, at: day('2026-10-20'), amount: 3000, direction: 'in', fundId: null, loanId: 22, fundName: null, num: 0,
      loanType: 'Monthly', repaymentType: 'Monthly', sub: 'RECOVERY', notes: 'Moved away', collectedBy: 'Arun', x1: null, x2: null },
    { kind: 'recovery_event', id: 3, at: day('2026-10-20'), amount: null, direction: 'none', fundId: null, loanId: 22, fundName: null, num: null,
      loanType: 'Monthly', repaymentType: 'Monthly', sub: 'settle', notes: 'Agreed', collectedBy: null, x1: 5500, x2: 1000 },
    { kind: 'auction_won', id: 101, at: day('2026-09-05'), amount: 45000, direction: 'out', fundId: 1, loanId: null, fundName: 'Fixed 50K', num: 1,
      loanType: null, repaymentType: null, sub: null, notes: null, collectedBy: 'Bala', x1: 50000, x2: null },
    { kind: 'contribution', id: 7, at: day('2026-09-02'), amount: 4000, direction: 'in', fundId: 1, loanId: null, fundName: 'Fixed 50K', num: 1,
      loanType: null, repaymentType: null, sub: null, notes: null, collectedBy: 'Arun', x1: 1000, x2: null },
    { kind: 'repayment', id: 8, at: day('2026-09-01'), amount: 500, direction: 'in', fundId: null, loanId: 22, fundName: null, num: 3,
      loanType: 'Monthly', repaymentType: 'Monthly', sub: 'interestOnly', notes: null, collectedBy: null, x1: null, x2: null },
    { kind: 'loan_disbursed', id: 22, at: day('2026-06-01'), amount: 9900, direction: 'out', fundId: null, loanId: 22, fundName: null, num: null,
      loanType: 'Monthly', repaymentType: 'Monthly', sub: null, notes: null, collectedBy: 'Bala', x1: 10000, x2: 100 },
    { kind: 'member_created', id: 5, at: day('2026-06-01'), amount: null, direction: 'none', fundId: null, loanId: null, fundName: null, num: null,
      loanType: null, repaymentType: null, sub: null, notes: null, collectedBy: null, x1: null, x2: null },
  ];
  const tl = loadTimeline(async (strings, ...values) => {
    const q = Prisma.sql(strings, ...values);
    calls.push(q);
    return /COUNT\(\*\)/.test(q.sql) ? [{ n: 42, moneyIn: 7500.004, moneyOut: 54900 }] : rows;
  });
  const params = (qs) => tl.parseTimelineQuery(new URLSearchParams(qs));

  assert.deepEqual(params(''), { page: 1, pageSize: 20, kind: null, account: null, from: null, to: null });
  assert.deepEqual(params('page=3&pageSize=5000&kind=money-in&account=loan-22&from=2026-01-01&to=2026-12-31'),
    { page: 3, pageSize: 100, kind: 'money-in', account: { type: 'loan', id: 22 }, from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(params('kind=contribution&account=loan-1%20OR%201=1&from=2026-1-1&page=-2'),
    { page: 1, pageSize: 20, kind: null, account: null, from: null, to: null }, 'unknown values are ignored');
  assert.equal(params('account=chit-99999999999').account, null, 'out-of-range ids are ignored');

  const r = await tl.getMemberTimeline(5, 7, params('page=2&pageSize=7'));
  assert.equal(calls.length, 2);
  const [list, count] = calls;
  for (const k of ['member_created', 'chit_joined', 'contribution', 'auction_won', 'loan_disbursed', 'repayment', 'recovery_event']) {
    assert.ok(list.sql.includes(`'${k}'::text`), k);
  }
  // 7 branches, each bound to the member and to the owner; then LIMIT 7 OFFSET 7
  assert.equal(list.values.filter((v) => v === 5).length, 7);
  assert.equal(list.values.filter((v) => v === 7).length, 7 + 2);
  assert.deepEqual(list.values.slice(-2), [7, 7]);
  assert.match(list.sql, /ORDER BY a\.at DESC, a\.rank DESC, a\.id DESC/);
  assert.equal(count.values.filter((v) => v === 5).length, 7);
  assert.equal((list.text.match(/"createdById" = \$\d+/g) || []).length, 7, 'every branch is owner-scoped');
  assert.match(list.sql, /e\.action <> 'collect'/, "collect events are left out (their RECOVERY receipt is the repayment row)");
  assert.doesNotMatch(list.sql, /WHEN 'collect'/);

  assert.equal(r.totalCount, 42);
  assert.equal(r.moneyIn, 7500);
  assert.equal(r.moneyOut, 54900);
  assert.deepEqual(r.meta, { page: 2, pageSize: 7, totalCount: 42, totalPages: 6, hasPrev: true, hasNext: true, sort: null, order: null, q: null });
  assert.deepEqual(r.items.map((i) => i.key), ['repayment-9', 'recovery_event-3', 'auction_won-101', 'contribution-7', 'repayment-8', 'loan_disbursed-22', 'member_created-5']);
  const [rec, settle, won, contrib, interest, disbursed, created] = r.items;
  assert.deepEqual(rec, { key: 'repayment-9', kind: 'repayment', date: day('2026-10-20').toISOString(), amount: 3000, direction: 'in', collectedBy: 'Arun',
    accountKey: 'loan-22', accountName: 'Loan #22 · Monthly', title: 'Offline recovery', detail: 'Moved away', href: '/loans/22' });
  assert.equal(settle.title, 'Recovery case settled');
  assert.equal(settle.amount, null);
  assert.equal(settle.detail, 'Waived ₹5,500 principal, ₹1,000 interest · Agreed');
  assert.equal(won.title, 'Won auction · Month 1');
  assert.equal(won.detail, 'Discount ₹5,000 on ₹50,000');
  assert.equal(won.href, '/chit-funds/1/auctions');
  assert.equal(won.direction, 'out');
  assert.equal(contrib.href, '/chit-funds/1/contributions?month=1');
  assert.equal(contrib.accountKey, 'chit-1');
  assert.equal(contrib.detail, 'Balance ₹1,000 pending');
  assert.equal(interest.title, 'Repayment · Installment 3');
  assert.equal(interest.detail, 'Interest only');
  assert.equal(disbursed.detail, 'Principal ₹10,000 · document charge ₹100 withheld');
  assert.equal(disbursed.amount, 9900);
  assert.deepEqual([created.accountKey, created.href, created.title], [null, null, 'Became a member']);

  const branchesFor = async (qs) => {
    calls.length = 0;
    await tl.getMemberTimeline(5, 7, params(qs));
    return ['member_created', 'chit_joined', 'contribution', 'auction_won', 'loan_disbursed', 'repayment', 'recovery_event'].filter((k) => calls[0]?.sql.includes(`'${k}'::text`));
  };
  assert.deepEqual(await branchesFor('kind=chit'), ['chit_joined', 'contribution', 'auction_won']);
  assert.deepEqual(await branchesFor('kind=loan'), ['loan_disbursed', 'repayment', 'recovery_event']);
  assert.deepEqual(await branchesFor('kind=money-in'), ['contribution', 'repayment']);
  assert.deepEqual(await branchesFor('kind=money-out'), ['auction_won', 'loan_disbursed']);
  assert.deepEqual(await branchesFor('account=chit-1'), ['chit_joined', 'contribution', 'auction_won']);
  assert.ok(calls[0].values.filter((v) => v === 1).length >= 3, 'fund id bound in each chit branch');
  assert.deepEqual(await branchesFor('account=loan-22&kind=money-in'), ['repayment']);
  assert.deepEqual(await branchesFor('account=loan-22&kind=chit'), []);
  assert.equal(calls.length, 0, 'no branch → no query');
  await branchesFor('from=2026-09-01&to=2026-09-30');
  assert.ok(calls[0].values.some((v) => v instanceof Date && v.getTime() === new Date('2026-09-01T00:00:00').getTime()));
  assert.ok(calls[0].values.some((v) => v instanceof Date && v.getTime() === new Date('2026-09-30T23:59:59.999').getTime()));
});

if (integration) test('database cross-check: per-member profit adds up to the dashboard formulas; timeline counts match rows', async () => {
  assert.match(process.env.DATABASE_URL, /:55439\//, 'throwaway database only');
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient();
  try {
    const owners = await db.user.findMany({ select: { id: true } });
    let authOwner = null;
    const original = Module._load;
    let route;
    try {
      Module._load = function(request, parent, isMain) {
        if (request.endsWith('/lib/auth')) return { getCurrentUserId: async () => authOwner, getActorUserId: async () => authOwner };
        return original.call(this, request, parent, isMain);
      };
      route = require('../app/api/members/consolidated/route');
    } finally { Module._load = original; }
    const get = async (qs) => {
      const res = await route.GET(new Request(`http://localhost/api/members/consolidated?${qs}`));
      return { status: res.status, body: await res.json() };
    };
    const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

    let checkedMembers = 0;
    let checkedFunds = 0;
    for (const owner of owners) {
      authOwner = owner.id;
      const members = await db.globalMember.findMany({ where: { createdById: owner.id }, select: { id: true } });
      if (!members.length) continue;
      const summaries = [];
      for (const m of members) {
        const res = await get(`action=summary&id=${m.id}`);
        assert.equal(res.status, 200);
        summaries.push(res.body);
      }
      checkedMembers += summaries.length;

      // 1. Σ member loanProfit = calculateTotalLoanProfit over all of this owner's loans
      const loans = await db.loan.findMany({ where: { createdById: owner.id }, include: { repayments: true } });
      const memberLoanProfit = summaries.reduce((s, x) => s + x.totals.loanProfit, 0);
      close(memberLoanProfit, calculateTotalLoanProfit(loans), 0.01 * Math.max(1, loans.length), `owner ${owner.id} loan profit`);

      // 2. per fund: Σ winners' commission = calculateChitFundProfitUpToCurrentMonth (the fund page's totalProfit)
      const funds = await db.chitFund.findMany({ where: { createdById: owner.id }, include: { contributions: true, auctions: true } });
      const byFund = new Map();
      for (const s of summaries) for (const c of s.chits) byFund.set(c.fundId, (byFund.get(c.fundId) || 0) + c.commission);
      for (const f of funds) {
        close(byFund.get(f.id) || 0, calculateChitFundProfitUpToCurrentMonth(f, f.contributions, f.auctions), 0.01 * Math.max(1, f.auctions.length), `fund ${f.id} commission`);
        checkedFunds += 1;
      }
    }
    assert.ok(checkedMembers > 0, 'seeded data present');

    // 3. timeline for the member with the most kinds of activity
    const [sample] = await db.$queryRaw`
      SELECT g.id, g."createdById" AS owner FROM "GlobalMember" g
      ORDER BY (SELECT COUNT(*) FROM "Loan" l JOIN "LoanRecoveryEvent" e ON e."loanId" = l.id WHERE l."borrowerId" = g.id) DESC,
               (SELECT COUNT(*) FROM "Auction" x JOIN "Member" m ON m.id = x."winnerId" WHERE m."globalMemberId" = g.id) DESC,
               (SELECT COUNT(*) FROM "Loan" l WHERE l."borrowerId" = g.id) DESC, g.id
      LIMIT 1`;
    authOwner = sample.owner;
    const id = sample.id;
    const own = { chitFund: { createdById: sample.owner } };
    const [memberships, contributions, auctions, loans, repayments, events] = await Promise.all([
      db.member.count({ where: { globalMemberId: id, ...own } }),
      db.contribution.count({ where: { member: { globalMemberId: id }, ...own } }),
      db.auction.count({ where: { winner: { globalMemberId: id }, ...own } }),
      db.loan.count({ where: { borrowerId: id, createdById: sample.owner } }),
      db.repayment.count({ where: { loan: { borrowerId: id, createdById: sample.owner } } }),
      db.loanRecoveryEvent.count({ where: { loan: { borrowerId: id, createdById: sample.owner }, action: { not: 'collect' } } }),
    ]);
    const all = await get(`action=timeline&id=${id}&pageSize=100`);
    assert.equal(all.status, 200);
    assert.equal(all.body.totalCount, 1 + memberships + contributions + auctions + loans + repayments + events);
    assert.equal(all.body.meta.totalCount, all.body.totalCount);
    const summary = (await get(`action=summary&id=${id}`)).body;
    close(all.body.moneyIn, summary.totals.moneyIn, 0.01, 'timeline money in = summary money in');
    close(all.body.moneyOut, summary.totals.moneyOut, 0.01, 'timeline money out = summary money out');
    assert.equal((await get(`action=timeline&id=${id}&kind=money-in`)).body.totalCount, contributions + repayments);
    assert.equal((await get(`action=timeline&id=${id}&kind=money-out`)).body.totalCount, auctions + loans);
    assert.equal((await get(`action=timeline&id=${id}&kind=loan`)).body.totalCount, loans + repayments + events);

    // Paging walks every event exactly once, newest first
    const keys = [];
    let last = Infinity;
    for (let page = 1; page <= 1000; page++) {
      const res = await get(`action=timeline&id=${id}&pageSize=7&page=${page}`);
      for (const item of res.body.items) {
        const t = new Date(item.date).getTime();
        assert.ok(t <= last, 'newest first');
        last = t;
        keys.push(item.key);
      }
      if (!res.body.meta.hasNext) break;
    }
    assert.equal(keys.length, all.body.totalCount);
    assert.equal(new Set(keys).size, keys.length);

    if (loans) {
      const loan = await db.loan.findFirst({ where: { borrowerId: id }, select: { id: true, _count: { select: { repayments: true, recoveryEvents: { where: { action: { not: 'collect' } } } } } } });
      const one = await get(`action=timeline&id=${id}&account=loan-${loan.id}`);
      assert.equal(one.body.totalCount, 1 + loan._count.repayments + loan._count.recoveryEvents);
      assert.ok(one.body.items.every((i) => i.accountKey === `loan-${loan.id}`));
    }
    const ranged = await get(`action=timeline&id=${id}&from=2000-01-01&to=2000-12-31`);
    assert.equal(ranged.body.totalCount, 0);

    // Ownership: another owner cannot read this member
    const other = owners.find((o) => o.id !== sample.owner);
    if (other) {
      authOwner = other.id;
      assert.equal((await get(`action=timeline&id=${id}`)).status, 403);
      assert.equal((await get(`action=summary&id=${id}`)).status, 403);
    }
    authOwner = sample.owner;
    assert.equal((await get('action=summary')).status, 400);
    assert.equal((await get('action=timeline&id=999999')).status, 404);
    console.log(`integration: ${checkedMembers} members, ${checkedFunds} funds, sample member ${id} with ${all.body.totalCount} events`);
  } finally {
    await db.$disconnect();
  }
});
