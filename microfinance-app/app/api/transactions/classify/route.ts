import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../lib/prisma';
import { getCurrentUserId } from '../../../../lib/auth';
import { MANUAL_TRANSACTION_TYPES, recordAmountDirection, validateRecordAmountCategory } from '../../../../lib/transactionValidation';
import { categoryAllowsDirection, isRecordAmountCategory, suggestRecordAmountCategory } from '../../../../lib/recordAmountCategories';

/**
 * Categories of manual Record Amount entries (lib/recordAmountCategories.ts).
 *
 * GET   /api/transactions/classify → the data owner's RECORD_AMOUNT entries that have no usable
 *       category (null, unknown, or not allowed for the entry's direction), oldest first, each
 *       with a suggestion from its note. Nothing is saved.
 * PATCH /api/transactions/classify  { items: [{ id, category }] } → sets the category of those
 *       entries, all or none. Only the category changes: amount, date, partners and the stored
 *       running balances stay as they are, and no notification is sent.
 */

const MAX_ITEMS = 100;
const RECORD_AMOUNT = MANUAL_TRANSACTION_TYPES.RECORD_AMOUNT;

export async function GET(request: NextRequest) {
  try {
    const currentUserId = await getCurrentUserId(request);
    if (!currentUserId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // Record Amount entries are few (manual only), so read them all and apply the same
    // "usable category" rule as the tax report in code.
    const rows = await prisma.transaction.findMany({
      where: { createdById: currentUserId, type: RECORD_AMOUNT },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        date: true,
        amount: true,
        note: true,
        category: true,
        from_partner_id: true,
        to_partner_id: true,
        from_partner: true,
        to_partner: true,
        fromPartner: { select: { name: true } },
        toPartner: { select: { name: true } },
      },
    });

    const entries = rows.flatMap((row) => {
      const direction = recordAmountDirection(row.from_partner_id, row.to_partner_id);
      if (!direction) return []; // no partner: the entry moves no cash, nothing to report
      if (isRecordAmountCategory(row.category) && categoryAllowsDirection(row.category, direction)) return [];
      const partnerName = direction === 'credit'
        ? row.toPartner?.name ?? row.to_partner ?? null
        : row.fromPartner?.name ?? row.from_partner ?? null;
      return [{
        id: row.id,
        date: row.date,
        amount: row.amount,
        direction,
        partnerName,
        note: row.note,
        category: row.category,
        suggestedCategory: suggestRecordAmountCategory(row.note, direction),
      }];
    });

    return NextResponse.json({ entries, count: entries.length });
  } catch (error) {
    console.error('Error fetching entries to classify:', error);
    return NextResponse.json({ error: 'Failed to load entries to classify' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const currentUserId = await getCurrentUserId(request);
    if (!currentUserId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const rawItems = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return NextResponse.json({ error: 'Send at least one entry to classify.' }, { status: 400 });
    }
    if (rawItems.length > MAX_ITEMS) {
      return NextResponse.json({ error: `Classify at most ${MAX_ITEMS} entries at a time.` }, { status: 400 });
    }

    const items: { id: number; category: unknown }[] = [];
    const seen = new Set<number>();
    for (const raw of rawItems) {
      const id = Number((raw as { id?: unknown } | null)?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return NextResponse.json({ error: 'Each entry needs a valid transaction id.' }, { status: 400 });
      }
      if (seen.has(id)) {
        return NextResponse.json({ error: `Transaction #${id} is listed twice.` }, { status: 400 });
      }
      seen.add(id);
      items.push({ id, category: (raw as { category?: unknown }).category });
    }

    // Only the data owner's own rows; another account's id reads as "not found".
    const rows = await prisma.transaction.findMany({
      where: { id: { in: items.map((i) => i.id) }, createdById: currentUserId },
      select: { id: true, type: true, from_partner_id: true, to_partner_id: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    const itemErrors: Record<number, string> = {};
    for (const item of items) {
      const row = byId.get(item.id);
      if (!row) {
        itemErrors[item.id] = 'Transaction not found.';
        continue;
      }
      if (row.type !== RECORD_AMOUNT) {
        itemErrors[item.id] = 'Only Record Amount entries have a category.';
        continue;
      }
      const direction = recordAmountDirection(row.from_partner_id, row.to_partner_id);
      if (!direction) {
        itemErrors[item.id] = 'This entry credits or debits no partner, so it cannot be classified.';
        continue;
      }
      const error = validateRecordAmountCategory(item.category, direction);
      if (error) itemErrors[item.id] = error;
    }

    const failed = Object.keys(itemErrors);
    if (failed.length > 0) {
      const notFound = items.every((i) => itemErrors[i.id] === 'Transaction not found.');
      const first = itemErrors[Number(failed[0])];
      return NextResponse.json(
        { error: items.length === 1 ? first : `${failed.length} of ${items.length} entries could not be classified: ${first}`, itemErrors },
        { status: notFound ? 404 : 400 }
      );
    }

    // Category only. The where clause repeats owner and type so nothing else can be touched.
    await prisma.$transaction(
      items.map((item) =>
        prisma.transaction.updateMany({
          where: { id: item.id, createdById: currentUserId, type: RECORD_AMOUNT },
          data: { category: item.category as string },
        })
      )
    );

    return NextResponse.json({ updated: items.map((i) => ({ id: i.id, category: i.category })) });
  } catch (error) {
    console.error('Error classifying entries:', error);
    return NextResponse.json({ error: 'Failed to save the categories' }, { status: 500 });
  }
}
