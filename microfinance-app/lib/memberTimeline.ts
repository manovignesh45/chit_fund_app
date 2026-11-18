/**
 * Member 360 timeline (GET /api/members/consolidated?action=timeline&id=<memberId>): every event in
 * one member's history, paged in the database. One UNION ALL over the event sources, built the same
 * way as getActivitiesList (lib/activitiesList.ts), each branch scoped to this member and to
 * records owned by the current user (createdById on GlobalMember / ChitFund / Loan).
 *
 *   kind       'chit' | 'loan' | 'money-in' | 'money-out'   (anything else = all events)
 *   account    'chit-<fundId>' | 'loan-<loanId>'           (anything else = all accounts)
 *   from, to   YYYY-MM-DD, inclusive, server-local days (same parsing as activitiesList)
 *   page, pageSize (at most MAX_PAGE_SIZE)
 *
 * Events: member_created, chit_joined, contribution, auction_won, loan_disbursed, repayment
 * (RECOVERY receipts = offline recovery), recovery_event (LoanRecoveryEvent: mark, settle, restore,
 * reverse). 'collect' events are left out: each one only records a RECOVERY receipt, which is already
 * its own repayment row with the amount. A loan's completion has no stored date, so there is no
 * "closed" event.
 *
 * Money: contribution and repayment are 'in'; loan_disbursed (amount − documentCharge, the cash
 * handed over) and auction_won (the payout) are 'out'; everything else has no amount (a settle that
 * also takes a final receipt has that receipt as its own repayment row, so nothing is counted twice).
 *
 * Order: newest first; same instant → later lifecycle step first (rank DESC), then id DESC.
 * All values reach SQL as bound parameters.
 */
import { Prisma } from '@prisma/client';
import prisma from './prisma';
import { formatMoney } from './format';
import { buildMeta, MAX_PAGE_SIZE, type ListMeta } from './list/types';

export const TIMELINE_KINDS = ['chit', 'loan', 'money-in', 'money-out'] as const;
export type TimelineKindFilter = (typeof TIMELINE_KINDS)[number];

export type TimelineEventKind =
  | 'member_created'
  | 'chit_joined'
  | 'contribution'
  | 'auction_won'
  | 'loan_disbursed'
  | 'repayment'
  | 'recovery_event';

export type TimelineDirection = 'in' | 'out' | 'none';

export interface MemberTimelineItem {
  /** unique across kinds, e.g. 'contribution-12' */
  key: string;
  kind: TimelineEventKind;
  /** ISO timestamp */
  date: string;
  amount: number | null;
  direction: TimelineDirection;
  /** 'chit-<fundId>' | 'loan-<loanId>' | null (member_created) */
  accountKey: string | null;
  accountName: string | null;
  title: string;
  detail: string | null;
  href: string | null;
  /** partner who handled the cash: collector for money in, disbursing partner for money out */
  collectedBy: string | null;
}

export interface MemberTimelineQuery {
  page: number;
  pageSize: number;
  kind: TimelineKindFilter | null;
  account: { type: 'chit' | 'loan'; id: number } | null;
  from: string | null;
  to: string | null;
}

export interface MemberTimelineResult {
  items: MemberTimelineItem[];
  /** events matching the filters (all pages) */
  totalCount: number;
  /** Σ amount of 'in' events matching the filters (all pages) */
  moneyIn: number;
  /** Σ amount of 'out' events matching the filters (all pages) */
  moneyOut: number;
  page: number;
  pageSize: number;
  totalPages: number;
  meta: ListMeta;
}

type SearchParamsLike = Pick<URLSearchParams, 'get'>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT = /^(chit|loan)-([1-9]\d{0,9})$/;

function positiveInt(value: string | null, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return n > 0 ? n : fallback;
}

export function parseTimelineQuery(searchParams: SearchParamsLike): MemberTimelineQuery {
  const rawKind = searchParams.get('kind');
  const kind = (TIMELINE_KINDS as readonly string[]).includes(rawKind ?? '') ? (rawKind as TimelineKindFilter) : null;
  const match = ACCOUNT.exec(searchParams.get('account') ?? '');
  const account = match && Number(match[2]) <= 2147483647 ? { type: match[1] as 'chit' | 'loan', id: Number(match[2]) } : null;
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  return {
    page: positiveInt(searchParams.get('page'), 1),
    pageSize: Math.min(positiveInt(searchParams.get('pageSize'), 20), MAX_PAGE_SIZE),
    kind,
    account,
    from: from && DAY.test(from) ? from : null,
    to: to && DAY.test(to) ? to : null,
  };
}

interface RawEvent {
  kind: TimelineEventKind;
  id: number;
  at: Date;
  amount: number | null;
  direction: TimelineDirection;
  fundId: number | null;
  loanId: number | null;
  fundName: string | null;
  num: number | null;
  loanType: string | null;
  repaymentType: string | null;
  sub: string | null;
  notes: string | null;
  collectedBy: string | null;
  x1: number | null;
  x2: number | null;
}

const money = (n: number | null | undefined) => formatMoney(n ?? 0);
const INTEREST_ONLY = ['interestOnly', 'INTEREST_ONLY'];

const RECOVERY_TITLES: Record<string, string> = {
  mark: 'Marked non-recoverable',
  settle: 'Recovery case settled',
  restore: 'Restored to active',
  reverse: 'Recovery receipt reversed',
};

function toItem(r: RawEvent): MemberTimelineItem {
  const chitKey = r.fundId != null ? `chit-${r.fundId}` : null;
  const loanKey = r.loanId != null ? `loan-${r.loanId}` : null;
  const loanName = r.loanId != null ? `Loan #${r.loanId} · ${r.loanType ?? ''}`.trim() : null;
  const base = {
    key: `${r.kind}-${r.id}`,
    kind: r.kind,
    date: new Date(r.at).toISOString(),
    amount: r.amount == null ? null : Math.round(r.amount * 100) / 100,
    direction: r.direction,
    collectedBy: r.collectedBy ?? null,
  };
  switch (r.kind) {
    case 'member_created':
      return { ...base, accountKey: null, accountName: null, title: 'Became a member', detail: null, href: null };
    case 'chit_joined':
      return { ...base, accountKey: chitKey, accountName: r.fundName, title: `Joined ${r.fundName ?? 'chit fund'}`,
        detail: r.x1 != null ? `Monthly contribution ${money(r.x1)}` : null, href: `/chit-funds/${r.fundId}` };
    case 'contribution':
      return { ...base, accountKey: chitKey, accountName: r.fundName, title: `Contribution · Month ${r.num}`,
        detail: [r.x1 ? `Balance ${money(r.x1)} pending` : null, r.notes || null].filter(Boolean).join(' · ') || null,
        href: `/chit-funds/${r.fundId}/contributions?month=${r.num}` };
    case 'auction_won': {
      const discount = r.x1 != null && r.amount != null ? r.x1 - r.amount : null;
      return { ...base, accountKey: chitKey, accountName: r.fundName, title: `Won auction · Month ${r.num}`,
        detail: discount != null ? `Discount ${money(discount)} on ${money(r.x1)}` : null,
        href: `/chit-funds/${r.fundId}/auctions` };
    }
    case 'loan_disbursed':
      return { ...base, accountKey: loanKey, accountName: loanName, title: 'Loan disbursed',
        detail: r.x2 ? `Principal ${money(r.x1)} · document charge ${money(r.x2)} withheld` : `Principal ${money(r.x1)}`,
        href: `/loans/${r.loanId}` };
    case 'repayment': {
      const recovery = r.sub === 'RECOVERY';
      const interestOnly = INTEREST_ONLY.includes(r.sub ?? '');
      const title = recovery
        ? 'Offline recovery'
        : `Repayment · ${r.repaymentType === 'Weekly' ? 'Week' : 'Installment'} ${r.num}`;
      return { ...base, accountKey: loanKey, accountName: loanName, title,
        detail: recovery ? r.notes || null : interestOnly ? 'Interest only' : r.notes || null,
        href: `/loans/${r.loanId}` };
    }
    default: {
      const action = r.sub ?? '';
      let figures: string | null = null;
      if (action === 'mark' && r.x1 != null) figures = `Principal outstanding ${money(r.x1)}`;
      else if (action === 'settle' && (r.x1 != null || r.x2 != null)) figures = `Waived ${money(r.x1)} principal, ${money(r.x2)} interest`;
      else if (action === 'reverse' && r.x1 != null) figures = `${money(r.x1)} reversed`;
      return { ...base, accountKey: loanKey, accountName: loanName, title: RECOVERY_TITLES[action] ?? 'Recovery update',
        detail: [figures, r.notes || null].filter(Boolean).join(' · ') || null, href: `/loans/${r.loanId}` };
    }
  }
}

/** A numeric field of LoanRecoveryEvent.details, or NULL when absent / not a number. */
function detailNumber(key: string): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof(e.details::jsonb -> ${key}::text) = 'number' THEN (e.details::jsonb ->> ${key}::text)::float8 END`;
}

export async function getMemberTimeline(
  memberId: number,
  userId: number,
  query: MemberTimelineQuery,
): Promise<MemberTimelineResult> {
  const { page, pageSize, kind, account, from, to } = query;
  const chitAccount = account?.type === 'chit' ? account.id : null;
  const loanAccount = account?.type === 'loan' ? account.id : null;

  // Which branches can match the filters (Postgres never reads the others).
  const chitSide = kind !== 'loan' && account?.type !== 'loan';
  const loanSide = kind !== 'chit' && account?.type !== 'chit';
  const wantIn = kind !== 'money-out';
  const wantOut = kind !== 'money-in';
  const wantNone = kind === null || kind === 'chit' || kind === 'loan';

  const fundFilter = chitAccount != null ? Prisma.sql`AND f.id = ${chitAccount}` : Prisma.empty;
  const loanFilter = loanAccount != null ? Prisma.sql`AND l.id = ${loanAccount}` : Prisma.empty;

  // Every branch selects, in this order and with these types (named by the alias list on `source`):
  // kind, rank, id, at, amount, direction, fundId, loanId, fundName, num, loanType, repaymentType,
  // sub, notes, collectedBy, x1, x2.
  const branches: Prisma.Sql[] = [];
  if (wantNone && account === null && kind === null) {
    branches.push(Prisma.sql`
      SELECT 'member_created'::text AS kind, 0 AS rank, g.id, g."createdAt" AS at, NULL::float8 AS amount, 'none'::text AS direction,
        NULL::int AS "fundId", NULL::int AS "loanId", NULL::text AS "fundName", NULL::int AS num, NULL::text AS "loanType",
        NULL::text AS "repaymentType", NULL::text AS sub, NULL::text AS notes, NULL::text AS "collectedBy", NULL::float8 AS x1, NULL::float8 AS x2
      FROM "GlobalMember" g
      WHERE g.id = ${memberId} AND g."createdById" = ${userId}`);
  }
  if (chitSide && wantNone) {
    branches.push(Prisma.sql`
      SELECT 'chit_joined'::text, 1, m.id, m."joinDate", NULL::float8, 'none'::text,
        f.id, NULL::int, f.name, NULL::int, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, f."monthlyContribution", NULL::float8
      FROM "Member" m
      JOIN "ChitFund" f ON f.id = m."chitFundId"
      WHERE m."globalMemberId" = ${memberId} AND f."createdById" = ${userId} ${fundFilter}`);
  }
  if (chitSide && wantIn) {
    branches.push(Prisma.sql`
      SELECT 'contribution'::text, 4, c.id, c."paidDate", c.amount, 'in'::text,
        f.id, NULL::int, f.name, c.month, NULL::text, NULL::text, NULL::text, c.notes, p.name, c.balance, NULL::float8
      FROM "Contribution" c
      JOIN "Member" m ON m.id = c."memberId"
      JOIN "ChitFund" f ON f.id = c."chitFundId"
      LEFT JOIN "Partner" p ON p.id = c.collected_by_id
      WHERE m."globalMemberId" = ${memberId} AND f."createdById" = ${userId} ${fundFilter}`);
  }
  if (chitSide && wantOut) {
    branches.push(Prisma.sql`
      SELECT 'auction_won'::text, 3, x.id, x.date, x.amount, 'out'::text,
        f.id, NULL::int, f.name, x.month, NULL::text, NULL::text, NULL::text, x.notes, p.name, f."totalAmount", NULL::float8
      FROM "Auction" x
      JOIN "Member" m ON m.id = x."winnerId"
      JOIN "ChitFund" f ON f.id = x."chitFundId"
      LEFT JOIN "Partner" p ON p.id = x.disbursed_by_id
      WHERE m."globalMemberId" = ${memberId} AND f."createdById" = ${userId} ${fundFilter}`);
  }
  if (loanSide && wantOut) {
    // Cash handed over = amount − documentCharge: the charge is kept back from the loan. (The ledger
    // records this gross, a LOAN_DISBURSEMENT of the full amount plus a DOCUMENT_CHARGE of the
    // charge, which nets to the same cash; see createLoan in app/api/loans/consolidated/route.ts.)
    branches.push(Prisma.sql`
      SELECT 'loan_disbursed'::text, 2, l.id, l."disbursementDate", l.amount - COALESCE(l."documentCharge", 0), 'out'::text,
        NULL::int, l.id, NULL::text, NULL::int, l."loanType", l."repaymentType", NULL::text, l.purpose, p.name, l.amount, l."documentCharge"
      FROM "Loan" l
      LEFT JOIN "Partner" p ON p.id = l.disbursed_by_id
      WHERE l."borrowerId" = ${memberId} AND l."createdById" = ${userId} ${loanFilter}`);
  }
  if (loanSide && wantIn) {
    branches.push(Prisma.sql`
      SELECT 'repayment'::text, 5, r.id, r."paidDate", r.amount, 'in'::text,
        NULL::int, l.id, NULL::text, r.period, l."loanType", l."repaymentType", r."paymentType", r.notes, p.name, NULL::float8, NULL::float8
      FROM "Repayment" r
      JOIN "Loan" l ON l.id = r."loanId"
      LEFT JOIN "Partner" p ON p.id = r.collected_by_id
      WHERE l."borrowerId" = ${memberId} AND l."createdById" = ${userId} ${loanFilter}`);
  }
  if (loanSide && wantNone) {
    const x1 = Prisma.sql`CASE e.action
          WHEN 'mark' THEN ${detailNumber('principal')}
          WHEN 'settle' THEN ${detailNumber('principalWaived')}
          WHEN 'reverse' THEN ${detailNumber('amountReversed')}
        END`;
    const x2 = Prisma.sql`CASE WHEN e.action = 'settle' THEN ${detailNumber('interestWaived')} END`;
    // 'collect' only records a RECOVERY receipt, which the repayment branch already lists.
    branches.push(Prisma.sql`
      SELECT 'recovery_event'::text, 6, e.id, e."createdAt", NULL::float8, 'none'::text,
        NULL::int, l.id, NULL::text, NULL::int, l."loanType", l."repaymentType", e.action, e.reason, NULL::text, ${x1}, ${x2}
      FROM "LoanRecoveryEvent" e
      JOIN "Loan" l ON l.id = e."loanId"
      WHERE l."borrowerId" = ${memberId} AND l."createdById" = ${userId} AND e.action <> 'collect' ${loanFilter}`);
  }

  const skip = (page - 1) * pageSize;
  if (!branches.length) {
    const meta = buildMeta({ page, pageSize, totalCount: 0 });
    return { items: [], totalCount: 0, moneyIn: 0, moneyOut: 0, page, pageSize, totalPages: meta.totalPages, meta };
  }

  const conditions: Prisma.Sql[] = [];
  // No `Z`: parsed as the server's local midnight, the same as getActivitiesList.
  if (from) conditions.push(Prisma.sql`a.at >= ${new Date(`${from}T00:00:00`)}`);
  if (to) conditions.push(Prisma.sql`a.at <= ${new Date(`${to}T23:59:59.999`)}`);
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  // Column names come from this alias list, so every branch may leave its columns unnamed.
  const source = Prisma.sql`(${Prisma.join(branches, ' UNION ALL ')})
    a(kind, rank, id, at, amount, direction, "fundId", "loanId", "fundName", num, "loanType", "repaymentType", sub, notes, "collectedBy", x1, x2)`;

  const [rows, totals] = await Promise.all([
    prisma.$queryRaw<RawEvent[]>`
      SELECT a.kind, a.id, a.at, a.amount, a.direction, a."fundId", a."loanId", a."fundName", a.num, a."loanType",
        a."repaymentType", a.sub, a.notes, a."collectedBy", a.x1, a.x2
      FROM ${source}
      ${where}
      ORDER BY a.at DESC, a.rank DESC, a.id DESC
      LIMIT ${pageSize} OFFSET ${skip}`,
    prisma.$queryRaw<{ n: number; moneyIn: number; moneyOut: number }[]>`
      SELECT COUNT(*)::int AS n,
        COALESCE(SUM(a.amount) FILTER (WHERE a.direction = 'in'), 0)::float8 AS "moneyIn",
        COALESCE(SUM(a.amount) FILTER (WHERE a.direction = 'out'), 0)::float8 AS "moneyOut"
      FROM ${source}
      ${where}`,
  ]);

  const totalCount = totals[0]?.n ?? 0;
  const meta = buildMeta({ page, pageSize, totalCount });
  return {
    items: rows.map(toItem),
    totalCount,
    moneyIn: Math.round((totals[0]?.moneyIn ?? 0) * 100) / 100,
    moneyOut: Math.round((totals[0]?.moneyOut ?? 0) * 100) / 100,
    page,
    pageSize,
    totalPages: meta.totalPages,
    meta,
  };
}
