// Run with: node tests/test-manual-transactions.js
// Add --database to exercise the route's locks against PostgreSQL from .env.
// Transaction records remain in memory in both modes.
// Covers mandatory audit notes and input validation for partner transfers / record amount,
// the Record Amount category (required, valid, fits the direction; set later through
// /api/transactions/classify without touching balances), plus the dues calculations shared
// by the pending modals and the Dues Tracker.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

function load(file, mocks = {}, globals = {}) {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  const context = {
    exports: {},
    console,
    ...globals,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  context.module = { exports: context.exports };
  vm.runInNewContext(outputText, context);
  return context.exports;
}

const cats = load("lib/recordAmountCategories.ts");
const v = load("lib/transactionValidation.ts", { "./recordAmountCategories": cats });
const now = new Date("2026-10-30T10:00:00Z");
const transfer = { type: "PARTNER_TO_PARTNER", amount: "5000", date: "2026-10-30", note: "Cash handover", from_partner_id: "1", to_partner_id: "2" };

// Happy paths
let r = v.validateManualTransaction(transfer, now);
assert.equal(r.ok, true);
assert.equal(r.value.amount, 5000);
assert.equal(r.value.fromPartnerId, 1);
assert.equal(r.value.toPartnerId, 2);
r = v.validateManualTransaction({ ...transfer, note: "  Cash   handover\n after collection " }, now);
assert.equal(r.value.note, "Cash handover after collection");
assert.equal(r.value.category, null, "a transfer has no category");
r = v.validateManualTransaction({ type: "RECORD_AMOUNT", amount: 1200.5, date: "2026-10-01", note: "Opening balance", from_partner_id: null, to_partner_id: 3, category: "OPENING_BALANCE" }, now);
assert.equal(r.ok, true);
assert.equal(r.value.fromPartnerId, null);
assert.equal(r.value.category, "OPENING_BALANCE");

// Note is mandatory for both manual types
for (const type of ["PARTNER_TO_PARTNER", "RECORD_AMOUNT"]) {
  const base = type === "RECORD_AMOUNT" ? { ...transfer, type, from_partner_id: null } : transfer;
  for (const note of [undefined, null, "", "   ", "abc", 42, "x".repeat(501)]) {
    r = v.validateManualTransaction({ ...base, note }, now);
    assert.equal(r.ok, false, `${type} note ${JSON.stringify(note)} should fail`);
    assert.ok(r.errors.note);
  }
}

// Amount
for (const amount of ["", "abc", "-5", "0", 0, -1, NaN, Infinity, "1e5", "10.555", 10.555, "1,000", 200000000]) {
  r = v.validateManualTransaction({ ...transfer, amount }, now);
  assert.equal(r.ok, false, `amount ${amount} should fail`);
  assert.ok(r.errors.amount);
}
assert.equal(v.validateManualTransaction({ ...transfer, amount: "10.55" }, now).ok, true);

// Date
for (const date of ["", "not-a-date", undefined, "2026-11-05"]) {
  r = v.validateManualTransaction({ ...transfer, date }, now);
  assert.equal(r.ok, false, `date ${date} should fail`);
  assert.ok(r.errors.date);
}

// Partners
assert.ok(v.validateManualTransaction({ ...transfer, from_partner_id: "" }, now).errors.from_partner_id);
assert.ok(v.validateManualTransaction({ ...transfer, to_partner_id: null }, now).errors.to_partner_id);
assert.ok(v.validateManualTransaction({ ...transfer, to_partner_id: "1" }, now).errors.to_partner_id);
assert.ok(v.validateManualTransaction({ ...transfer, from_partner_id: "1.5" }, now).errors.from_partner_id);
const rec = { ...transfer, type: "RECORD_AMOUNT" };
assert.equal(v.validateManualTransaction(rec, now).ok, false, "record amount cannot touch two partners");
assert.equal(v.validateManualTransaction({ ...rec, from_partner_id: null, to_partner_id: null }, now).ok, false);
assert.equal(v.validateManualTransaction({ ...rec, to_partner_id: null, category: "EXPENSE" }, now).ok, true);
assert.equal(v.validateManualTransaction({ ...transfer, type: "LOAN_REPAYMENT" }, now).ok, false);
assert.equal(v.isManualTransactionType("RECORD_AMOUNT"), true);
assert.equal(v.isManualTransactionType("CHIT_CONTRIBUTION"), false);

// Record Amount category: required, a known value, and allowed for the direction.
const credit = { type: "RECORD_AMOUNT", amount: "1000", date: "2026-10-30", note: "Money brought in", from_partner_id: null, to_partner_id: "1" };
const debit = { ...credit, from_partner_id: "1", to_partner_id: null };
for (const category of [undefined, null, "", "FOO", "expense", 3]) {
  r = v.validateManualTransaction({ ...credit, category }, now);
  assert.equal(r.ok, false, `category ${JSON.stringify(category)} should fail`);
  assert.ok(r.errors.category);
}
assert.match(v.validateManualTransaction({ ...credit }, now).errors.category, /Choose a category/);
for (const category of ["OPENING_BALANCE", "CAPITAL_IN", "OTHER_INCOME", "ADVANCE_RETURNED", "CORRECTION"]) {
  assert.equal(v.validateManualTransaction({ ...credit, category }, now).ok, true, `${category} is a credit category`);
}
for (const category of ["DRAWINGS", "EXPENSE", "ADVANCE_GIVEN", "CORRECTION"]) {
  assert.equal(v.validateManualTransaction({ ...debit, category }, now).ok, true, `${category} is a debit category`);
}
r = v.validateManualTransaction({ ...credit, category: "EXPENSE" }, now);
assert.equal(r.ok, false);
assert.equal(r.errors.category, "Expense cannot be a credit. Choose a credit category.");
r = v.validateManualTransaction({ ...debit, category: "OPENING_BALANCE" }, now);
assert.equal(r.errors.category, "Opening balance cannot be a debit. Choose a debit category.");
// With both or neither partner set only the partner error matters for the direction.
r = v.validateManualTransaction({ ...credit, from_partner_id: "1", category: "EXPENSE" }, now);
assert.ok(r.errors.to_partner_id);
assert.equal(r.errors.category, undefined);
// A transfer ignores any category sent.
r = v.validateManualTransaction({ ...transfer, category: "EXPENSE" }, now);
assert.equal(r.ok, true);
assert.equal(r.value.category, null);
// Helpers shared with the form, the exports and the classify route.
assert.equal(v.recordAmountDirection(null, 4), "credit");
assert.equal(v.recordAmountDirection(4, null), "debit");
assert.equal(v.recordAmountDirection(null, null), null);
assert.equal(v.recordAmountCategoryLabel("EXPENSE"), "Expense");
assert.equal(v.recordAmountCategoryLabel(null), "Unclassified");
assert.equal(v.recordAmountCategoryLabel("FOO"), "Unclassified");
assert.equal(JSON.stringify(v.recordAmountCategoriesFor("credit").map((c) => c.value)), JSON.stringify(["OPENING_BALANCE", "CAPITAL_IN", "OTHER_INCOME", "ADVANCE_RETURNED", "CORRECTION"]));
assert.equal(JSON.stringify(v.recordAmountCategoriesFor("debit").map((c) => c.value)), JSON.stringify(["DRAWINGS", "EXPENSE", "ADVANCE_GIVEN", "CORRECTION"]));
// The category picker replaces the Record Amount note chips; transfers keep theirs.
assert.equal(v.NOTE_SUGGESTIONS.RECORD_AMOUNT, undefined);
assert.ok(v.NOTE_SUGGESTIONS.PARTNER_TO_PARTNER.length > 0);

// ---- Dues tracker ----
const d = load("lib/duesTracker.ts", { "./monthlyAggregations": load("lib/monthlyAggregations.ts") });
const asOf = new Date(2026, 9, 30); // 30 Oct 2026
const all = { start: new Date(0), end: new Date(2026, 10, 30) };

const loan = {
  disbursementDate: new Date(2026, 5, 15), // 15 Jun → due 15 Jul, Aug, Sep, Oct, Nov...
  duration: 10, repaymentType: "Monthly", installmentAmount: 1000,
  repayments: [
    { period: 1, amount: 1000, paidDate: new Date(2026, 6, 15) },
    { period: 2, amount: 400, paidDate: new Date(2026, 7, 16) },
    { period: 3, amount: 600, paidDate: null }, // unpaid record does not count
  ],
};
let periods = d.computeLoanDuePeriods(loan, all, asOf);
assert.equal(JSON.stringify(periods.map((p) => p.period)), JSON.stringify([2, 3, 4, 5]));
assert.equal(periods[0].outstanding, 600);
assert.equal(periods[0].paid, 400);
assert.equal(periods[0].status, "overdue");
assert.equal(periods[2].daysOverdue, 15); // 15 Oct → 30 Oct
assert.equal(periods[3].status, "upcoming");
let s = d.summarizePeriods(periods);
assert.equal(s.totalOutstanding, 3600);
assert.equal(s.overdueAmount, 2600);
assert.equal(s.upcomingAmount, 1000);
assert.equal(s.overduePeriods, 3);
assert.equal(s.maxDaysOverdue, periods[0].daysOverdue);
const aging = d.addToAging(d.emptyAging(), periods);
assert.equal(aging["1-30"], 1000);
assert.equal(aging["31-60"], 1000);
assert.equal(aging["61-90"], 600);
assert.equal(aging["90+"], 0);

// Weekly loan & range filtering
const weekly = { ...loan, repaymentType: "Weekly", disbursementDate: new Date(2026, 9, 1), repayments: [] };
periods = d.computeLoanDuePeriods(weekly, { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) }, asOf);
assert.equal(JSON.stringify(periods.map((p) => p.period)), JSON.stringify([1, 2, 3, 4]));
assert.equal(periods[3].dueDate, new Date(2026, 9, 29).toISOString());
assert.equal(d.computeLoanDuePeriods({ ...loan, installmentAmount: 0 }, all, asOf).length, 0);

// Chit: first-month amount, settled balance, partial payments
const fund = { startDate: new Date(2026, 7, 5), duration: 5, monthlyContribution: 2000, firstMonthContribution: 1500 };
periods = d.computeChitMemberDuePeriods(fund, [
  { month: 1, amount: 1000, paidDate: new Date(2026, 7, 5) },
  { month: 2, amount: 1500, paidDate: new Date(2026, 8, 5), balancePaymentStatus: "Paid" },
], all, asOf);
assert.equal(JSON.stringify(periods.map((p) => p.period)), JSON.stringify([1, 3, 4]));
assert.equal(periods[0].expected, 1500);
assert.equal(periods[0].outstanding, 500);
assert.equal(periods[1].outstanding, 2000);
assert.equal(periods[2].status, "upcoming");

assert.equal(d.dueStatus(new Date(2026, 9, 30, 18), asOf), "due-today");
assert.equal(d.agingBucket(30), "1-30");
assert.equal(d.agingBucket(91), "90+");

console.log("PASS: manual transaction validation (required notes, amount, date, partners, record amount category) and dues tracker calculations.");

// ---- POST /api/transactions (manual entries) with an in-memory DB ----
let lockDatabase;
(async () => {
  if (process.argv.includes("--database")) {
    require("dotenv").config({ path: path.join(root, ".env") });
    const { PrismaClient } = require("@prisma/client");
    lockDatabase = new PrismaClient();
  }
  const rows = [];
  const partnersDb = [
    { id: 1, name: "Arun", isActive: true, createdById: 7 },
    { id: 2, name: "Bala", isActive: true, createdById: 7 },
    { id: 3, name: "Other", isActive: true, createdById: 99 },
    { id: 4, name: "Gone", isActive: false, createdById: 7 },
  ];
  const notifications = [];
  const matches = (row, where) =>
    Object.entries(where).every(([k, cond]) => {
      if (k === "OR") return cond.some((c) => matches(row, c));
      if (k === "AND") return cond.every((c) => matches(row, c));
      const isDate = (x) => x && typeof x.getTime === "function";
      if (isDate(cond)) return isDate(row[k]) && row[k].getTime() === cond.getTime();
      if (cond && typeof cond === "object") {
        if ("not" in cond) return row[k] !== cond.not;
        if ("gte" in cond) return row[k] >= cond.gte;
        if ("in" in cond) return cond.in.includes(row[k]);
        if ("notIn" in cond) return !cond.notIn.includes(row[k]);
        if ("lt" in cond) return row[k] < cond.lt;
      }
      return row[k] === cond;
    });
  const txModel = {
    async findFirst({ where }) {
      return [...rows].reverse().find((r) => matches(r, where)) || null;
    },
    async findMany({ where }) {
      return rows.filter((r) => matches(r, where));
    },
    async create({ data }) {
      const row = { id: rows.length + 1, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    async updateMany({ where, data }) {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
  let locks = 0;
  const prisma = {
    partner: {
      async findFirst({ where }) { return partnersDb.find((p) => matches(p, where)) || null; },
      async findMany({ where }) { return partnersDb.filter((p) => matches(p, where)); },
    },
    transaction: txModel,
    async $transaction(fn) {
      const run = (dbTx) => fn({
        transaction: txModel,
        async $executeRaw(...args) {
          locks++;
          if (dbTx) return dbTx.$executeRaw(...args);
          return 0;
        },
      });
      return lockDatabase ? lockDatabase.$transaction(run) : run();
    },
  };
  const balance = load("lib/balanceCalculator.ts", { "./prisma": { default: prisma } });
  const route = load("app/api/transactions/route.ts", {
    "next/server": { NextResponse: { json: (body, o) => ({ body, status: o?.status ?? 200 }) } },
    "../../../lib/prisma": { default: prisma, __esModule: true },
    "../../../lib/auth": { getCurrentUserId: async () => 7, getActorUserId: async () => 7 },
    "../../../config/config": require("../config/config.js"),
    "../../../lib/emailConfig": {},
    // Used only by GET and the email export, which these tests do not call.
    "../../../lib/escapeHtml": {},
    "../../../lib/list/server": {},
    "../../../lib/list/types": {},
    xlsx: {},
    "../../../lib/balanceCalculator": balance,
    "../../../lib/transactionWhereBuilder": {},
    "../../../lib/transactionExportNameGenerator": {},
    "../../../lib/notifications": { notifyOtherAdmins: async (n) => notifications.push(n), getActorName: async () => "Admin" },
    "../../../lib/transactionValidation": v,
  }, { URL, Date });
  const today = new Date().toISOString().slice(0, 10);
  const post = (body) =>
    route.POST({
      url: "http://x/api/transactions",
      headers: { get: (h) => (h === "x-active-partner" ? "Arun" : null) },
      json: async () => body,
    });

  const base = { type: "PARTNER_TO_PARTNER", amount: "5000", date: today, from_partner_id: 1, to_partner_id: 2 };
  let res = await post({ ...base, note: "" });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.note);
  res = await post({ ...base, to_partner_id: 3, note: "Cash handover" });
  assert.equal(res.status, 400, "partner from another account is rejected");
  res = await post({ ...base, to_partner_id: 4, note: "Cash handover" });
  assert.equal(res.status, 400, "inactive partner is rejected");
  assert.equal(rows.length, 0);

  res = await post({ ...base, note: "  Cash handover  " });
  assert.equal(res.status, 201);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, "Transfer to Bala - Cash handover");
  assert.equal(rows[1].note, "Transfer from Arun - Cash handover");
  assert.equal(rows[0].partnerBalance, -5000);
  assert.equal(rows[1].partnerBalance, 5000);
  assert.equal(rows[1].totalBalance, 0);
  assert.equal(locks, 1);
  assert.match(notifications[0].message, /Cash handover/);
  assert.equal(notifications[0].link, "/transactions?txn=1,2");
  assert.equal(notifications[0].entityType, "transaction");
  assert.equal(notifications[0].entityId, 1);
  assert.equal(notifications[0].details.reason, "Cash handover");
  assert.equal(notifications[0].details.direction, "transfer");
  assert.equal(notifications[0].details.fromPartner, "Arun");
  assert.equal(notifications[0].details.toPartner, "Bala");
  assert.equal(JSON.stringify(notifications[0].details.transactionIds), "[1,2]");

  res = await post({ ...base, note: "Cash handover" });
  assert.equal(res.status, 409, "identical resubmission is rejected");
  assert.equal(rows.length, 2);

  assert.equal(rows[0].category ?? null, null, "transfer rows carry no category");
  assert.equal(rows[1].category ?? null, null);

  res = await post({ type: "RECORD_AMOUNT", amount: 1000, date: today, note: "Capital investment", from_partner_id: null, to_partner_id: 1 });
  assert.equal(res.status, 400, "record amount needs a category");
  assert.ok(res.body.fieldErrors.category);
  res = await post({ type: "RECORD_AMOUNT", amount: 1000, date: today, note: "Capital investment", from_partner_id: null, to_partner_id: 1, category: "DRAWINGS" });
  assert.equal(res.status, 400, "a debit category on a credit is rejected");
  assert.match(res.body.fieldErrors.category, /cannot be a credit/);
  assert.equal(rows.length, 2);
  res = await post({ type: "RECORD_AMOUNT", amount: 1000, date: today, note: "Capital investment", from_partner_id: null, to_partner_id: 1, category: "CAPITAL_IN" });
  assert.equal(res.status, 201);
  assert.equal(rows[2].category, "CAPITAL_IN");
  assert.equal(rows[2].partnerBalance, -4000);
  assert.equal(rows[2].totalBalance, 1000);
  res = await post({ type: "RECORD_AMOUNT", amount: 1000, date: today, note: "", from_partner_id: null, to_partner_id: 1 });
  assert.equal(res.status, 400, "record amount needs a reason");
  assert.equal(notifications[1].details.direction, "credit");
  assert.equal(notifications[1].details.category, "CAPITAL_IN");
  assert.equal("category" in notifications[0].details, false, "transfer notifications carry no category");
  assert.equal(notifications[1].link, "/transactions?txn=3");

  res = await post({ type: "RECORD_AMOUNT", amount: 250, date: today, note: "Capital withdrawal", from_partner_id: 1, to_partner_id: null, category: "DRAWINGS" });
  assert.equal(res.status, 201);
  assert.equal(rows[3].category, "DRAWINGS");
  assert.equal(rows[3].partnerBalance, -4250);
  assert.equal(rows[3].totalBalance, 750);
  assert.equal(notifications[2].details.direction, "debit");
  res = await post({ type: "RECORD_AMOUNT", amount: 250, date: today, note: "Capital withdrawal", from_partner_id: 1, to_partner_id: null, category: "DRAWINGS" });
  assert.equal(res.status, 409, "identical record amount resubmission is rejected");
  assert.equal(rows.length, 4);
  assert.equal(notifications.length, 3, "duplicates do not send notifications");
  assert.equal(locks, 5, "transfers, credits, debits and duplicate checks acquire the lock");

  // GET /api/notifications/:id/details
  const notificationsDb = [
    { id: 10, userId: 5, entityType: "transaction", entityId: 1, details: { transactionIds: [1, 2] } },
    { id: 11, userId: 5, entityType: "transaction", entityId: 999, details: { transactionIds: [999] } },
    { id: 12, userId: 5, entityType: null, entityId: null, details: null, link: "/loans/4" },
    { id: 13, userId: 6, entityType: "transaction", entityId: 1, details: { transactionIds: [1, 2] } },
  ];
  const detailsRoute = load("app/api/notifications/[id]/details/route.ts", {
    "next/server": { NextResponse: { json: (body, o) => ({ body, status: o?.status ?? 200 }) } },
    "../../../../../lib/prisma": {
      default: {
        notification: { async findFirst({ where }) { return notificationsDb.find((n) => matches(n, where)) || null; } },
        transaction: txModel,
      },
      __esModule: true,
    },
    "../../../../../lib/auth": { getCurrentUserId: async () => 7, getActorUserId: async () => 5 },
  });
  const details = (id) => detailsRoute.GET({}, { params: Promise.resolve({ id: String(id) }) });
  res = await details(10);
  assert.equal(res.status, 200);
  assert.equal(res.body.transactions.length, 2);
  assert.equal(res.body.entityMissing, false);
  res = await details(11);
  assert.equal(res.body.entityMissing, true, "deleted transaction is reported, not an error");
  res = await details(12);
  assert.equal(res.status, 200);
  assert.equal(res.body.transactions.length, 0);
  assert.equal(res.body.entityMissing, false);
  assert.equal((await details(13)).status, 404, "cannot open another user's notification");
  assert.equal((await details("abc")).status, 400);

  // ---- /api/transactions/classify: list unclassified Record Amount entries, set categories ----
  const recordRow = (id, fields) => ({
    id, type: "RECORD_AMOUNT", amount: 1000, createdById: 7, category: null, from_partner_id: null, to_partner_id: null,
    from_partner: null, to_partner: null, partnerBalance: 1000, totalBalance: 2000, action_performer: "Arun", entered_by: "Arun",
    createdAt: new Date(), ...fields,
  });
  rows.push(
    recordRow(5, { date: new Date("2025-06-30"), to_partner_id: 1, to_partner: "Arun", note: "Old amount reset", amount: 144424 }),
    recordRow(6, { date: new Date("2025-08-01"), from_partner_id: 2, from_partner: "Bala", note: "Office tea and snacks", amount: 1200 }),
    recordRow(7, { date: new Date("2025-08-02"), to_partner_id: 3, to_partner: "Other", note: "Other account entry", createdById: 99 }),
    recordRow(8, { date: new Date("2025-09-01"), from_partner_id: 1, from_partner: "Arun", note: "Misc", category: "OPENING_BALANCE" }),
    recordRow(9, { date: new Date("2025-09-02"), note: "No partner at all" }),
  );
  let classifyUser = 7;
  const notificationsBefore = notifications.length;
  const classifyRoute = load("app/api/transactions/classify/route.ts", {
    "next/server": { NextResponse: { json: (body, o) => ({ body, status: o?.status ?? 200 }) } },
    "../../../../lib/prisma": {
      default: { transaction: txModel, $transaction: async (ops) => Promise.all(ops) },
      __esModule: true,
    },
    "../../../../lib/auth": { getCurrentUserId: async () => classifyUser },
    "../../../../lib/transactionValidation": v,
    "../../../../lib/recordAmountCategories": cats,
  });
  const listUnclassified = () => classifyRoute.GET({ url: "http://x/api/transactions/classify" });
  const patch = (body) => classifyRoute.PATCH({ json: async () => body });

  res = await listUnclassified();
  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(res.body.entries.map((e) => e.id)), "[5,6,8]", "own rows without a usable category, oldest first; no-partner rows skipped");
  assert.equal(res.body.count, 3);
  const [e5, e6, e8] = res.body.entries;
  assert.equal(e5.direction, "credit");
  assert.equal(e5.partnerName, "Arun");
  assert.equal(e5.amount, 144424);
  assert.equal(e5.note, "Old amount reset");
  assert.equal(e5.suggestedCategory, "OPENING_BALANCE");
  assert.equal(e6.direction, "debit");
  assert.equal(e6.partnerName, "Bala");
  assert.equal(e6.suggestedCategory, "EXPENSE");
  assert.equal(e8.category, "OPENING_BALANCE", "a category that does not fit the direction is listed again");
  assert.equal(e8.suggestedCategory, null);

  const snapshot = () => JSON.stringify(rows.map(({ category, ...rest }) => rest));
  const before = snapshot();
  assert.equal((await patch({ items: [] })).status, 400);
  assert.equal((await patch({})).status, 400);
  assert.equal((await patch({ items: Array.from({ length: 101 }, (_, i) => ({ id: i + 1, category: "EXPENSE" })) })).status, 400);
  assert.equal((await patch({ items: [{ id: "x", category: "EXPENSE" }] })).status, 400);
  assert.equal((await patch({ items: [{ id: 6, category: "EXPENSE" }, { id: 6, category: "EXPENSE" }] })).status, 400, "duplicate ids");
  res = await patch({ items: [{ id: 7, category: "OPENING_BALANCE" }] });
  assert.equal(res.status, 404, "another account's entry is not found");
  res = await patch({ items: [{ id: 1, category: "CORRECTION" }] });
  assert.equal(res.status, 400);
  assert.equal(res.body.itemErrors[1], "Only Record Amount entries have a category.");
  res = await patch({ items: [{ id: 9, category: "CORRECTION" }] });
  assert.equal(res.status, 400, "an entry with no partner has no direction");
  res = await patch({ items: [{ id: 5, category: "EXPENSE" }] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Expense cannot be a credit. Choose a credit category.");
  assert.equal((await patch({ items: [{ id: 5, category: "FOO" }] })).status, 400);
  assert.equal((await patch({ items: [{ id: 5, category: null }] })).status, 400, "a category cannot be cleared");
  res = await patch({ items: [{ id: 5, category: "OPENING_BALANCE" }, { id: 6, category: "OPENING_BALANCE" }] });
  assert.equal(res.status, 400, "one bad item rejects the batch");
  assert.ok(res.body.itemErrors[6]);
  assert.equal(res.body.itemErrors[5], undefined);
  assert.equal(rows.find((x) => x.id === 5).category, null, "all or none: nothing saved");
  classifyUser = null;
  assert.equal((await patch({ items: [{ id: 5, category: "OPENING_BALANCE" }] })).status, 401);
  assert.equal((await listUnclassified()).status, 401);
  classifyUser = 7;

  res = await patch({ items: [{ id: 5, category: "OPENING_BALANCE" }, { id: 6, category: "EXPENSE" }] });
  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(res.body.updated), JSON.stringify([{ id: 5, category: "OPENING_BALANCE" }, { id: 6, category: "EXPENSE" }]));
  assert.equal(rows.find((x) => x.id === 5).category, "OPENING_BALANCE");
  assert.equal(rows.find((x) => x.id === 6).category, "EXPENSE");
  // An already classified entry can be changed, under the same direction rule.
  assert.equal((await patch({ items: [{ id: 3, category: "CORRECTION" }] })).status, 200);
  assert.equal(rows[2].category, "CORRECTION");
  assert.equal((await patch({ items: [{ id: 4, category: "OTHER_INCOME" }] })).status, 400, "a debit cannot become other income");
  assert.equal(rows[3].category, "DRAWINGS");
  assert.equal(snapshot(), before, "only the category changes: amounts, dates, partners and balances stay");
  assert.equal(notifications.length, notificationsBefore, "classifying sends no notification");
  assert.equal(rows.find((x) => x.id === 7).category, null, "another account's entry is untouched");
  res = await listUnclassified();
  assert.equal(JSON.stringify(res.body.entries.map((e) => e.id)), "[8]");

  console.log("PASS: POST /api/transactions enforces reasons, categories, partner ownership, duplicate guard and balances; notification details endpoint.");
  console.log("PASS: /api/transactions/classify lists unclassified entries with suggestions and sets categories (owner-scoped, direction-checked, all or none, balances untouched).");
  if (lockDatabase) console.log("PASS: route lock queries executed against PostgreSQL; no transaction records written.");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(async () => {
  if (lockDatabase) await lockDatabase.$disconnect();
});
