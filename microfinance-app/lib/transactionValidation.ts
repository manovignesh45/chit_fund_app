/**
 * Validation rules for manually entered partner transactions
 * (Partner-to-Partner transfers and Record Amount credit/debit).
 *
 * Shared by the API route and the TransactionForm so the client shows the
 * same errors the server enforces. The server is the source of truth.
 */
import {
  RECORD_AMOUNT_CATEGORIES,
  categoryAllowsDirection,
  isRecordAmountCategory,
  type RecordAmountCategory,
  type RecordAmountDirection,
} from './recordAmountCategories';

export const MANUAL_TRANSACTION_TYPES = {
  PARTNER_TO_PARTNER: 'PARTNER_TO_PARTNER',
  RECORD_AMOUNT: 'RECORD_AMOUNT',
} as const;

export const NOTE_MIN_LENGTH = 5;
export const NOTE_MAX_LENGTH = 500;
export const MAX_TRANSACTION_AMOUNT = 100_000_000; // ₹10 crore sanity cap
/** Allow small clock/timezone skew; anything further ahead is a typo. */
const MAX_FUTURE_DAYS = 1;

/**
 * Suggested reasons shown as quick-pick chips in the form. Record Amount has none: its
 * category picker (lib/recordAmountCategories.ts) says what kind of entry it is.
 */
export const NOTE_SUGGESTIONS: Record<string, string[]> = {
  PARTNER_TO_PARTNER: [
    'Cash handover',
    'Bank deposit by partner',
    'Collection settlement',
    'Funds for loan disbursement',
    'Funds for auction payout',
  ],
};

export interface ManualTransactionInput {
  type?: unknown;
  amount?: unknown;
  date?: unknown;
  note?: unknown;
  from_partner_id?: unknown;
  to_partner_id?: unknown;
  /** RECORD_AMOUNT only (required); ignored for PARTNER_TO_PARTNER. */
  category?: unknown;
}

export interface ValidatedManualTransaction {
  type: 'PARTNER_TO_PARTNER' | 'RECORD_AMOUNT';
  amount: number;
  date: Date;
  note: string;
  fromPartnerId: number | null;
  toPartnerId: number | null;
  /** Always null for PARTNER_TO_PARTNER. */
  category: RecordAmountCategory | null;
}

export type FieldErrors = Partial<Record<'type' | 'amount' | 'date' | 'note' | 'from_partner_id' | 'to_partner_id' | 'category', string>>;

export type ValidationResult =
  | { ok: true; value: ValidatedManualTransaction }
  | { ok: false; errors: FieldErrors };

export function isManualTransactionType(type: unknown): type is ValidatedManualTransaction['type'] {
  return type === MANUAL_TRANSACTION_TYPES.PARTNER_TO_PARTNER || type === MANUAL_TRANSACTION_TYPES.RECORD_AMOUNT;
}

/** Collapse internal whitespace and trim so "  a   b " is stored as "a b". */
export function normalizeNote(note: unknown): string {
  return typeof note === 'string' ? note.replace(/\s+/g, ' ').trim() : '';
}

export function validateNote(note: unknown): string | undefined {
  const value = normalizeNote(note);
  if (!value) return 'A reason is required so this entry can be audited later.';
  if (value.length < NOTE_MIN_LENGTH) return `Reason must be at least ${NOTE_MIN_LENGTH} characters.`;
  if (value.length > NOTE_MAX_LENGTH) return `Reason must be at most ${NOTE_MAX_LENGTH} characters.`;
  return undefined;
}

export function parseAmount(amount: unknown): number | null {
  if (typeof amount === 'number') return Number.isFinite(amount) ? amount : null;
  if (typeof amount !== 'string' || !/^\s*\d+(\.\d+)?\s*$/.test(amount)) return null;
  return parseFloat(amount);
}

export function validateAmount(amount: unknown): string | undefined {
  const value = parseAmount(amount);
  if (value === null) return 'Enter a valid amount.';
  if (value <= 0) return 'Amount must be greater than zero.';
  if (Math.round(value * 100) / 100 !== value) return 'Amount can have at most 2 decimal places.';
  if (value > MAX_TRANSACTION_AMOUNT) return 'Amount is unusually large. Please double-check it.';
  return undefined;
}

/** Parse a YYYY-MM-DD (or ISO) date; returns null when invalid. */
export function parseTransactionDate(date: unknown): Date | null {
  if (typeof date !== 'string' || !date.trim()) return null;
  const parsed = new Date(date);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function validateDate(date: unknown, now: Date = new Date()): string | undefined {
  const parsed = parseTransactionDate(date);
  if (!parsed) return 'Enter a valid date.';
  const limit = new Date(now.getTime() + MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000);
  if (parsed > limit) return 'Date cannot be in the future.';
  return undefined;
}

/**
 * A Record Amount entry is a credit when it has a to-partner, else a debit when it has a
 * from-partner (the rule lib/itrReport.ts and the balance replay use); null when neither.
 */
export function recordAmountDirection(fromPartnerId: unknown, toPartnerId: unknown): RecordAmountDirection | null {
  if (toPartnerId !== null && toPartnerId !== undefined && toPartnerId !== '') return 'credit';
  if (fromPartnerId !== null && fromPartnerId !== undefined && fromPartnerId !== '') return 'debit';
  return null;
}

/** The categories a Record Amount entry in this direction may use, in display order. */
export function recordAmountCategoriesFor(direction: RecordAmountDirection) {
  return RECORD_AMOUNT_CATEGORIES.filter((c) => c.directions.includes(direction));
}

/** Display label for a stored category; "Unclassified" for null or an unknown value. */
export function recordAmountCategoryLabel(category: unknown): string {
  return RECORD_AMOUNT_CATEGORIES.find((c) => c.value === category)?.label ?? 'Unclassified';
}

/**
 * A Record Amount category: required, one of RECORD_AMOUNT_CATEGORIES, and allowed for the
 * entry's direction (skipped when the direction is not known yet).
 */
export function validateRecordAmountCategory(category: unknown, direction: RecordAmountDirection | null): string | undefined {
  if (category === null || category === undefined || category === '') return 'Choose a category so this entry is reported on the right line.';
  if (!isRecordAmountCategory(category)) return 'Choose a category from the list.';
  if (direction && !categoryAllowsDirection(category, direction)) {
    return `${recordAmountCategoryLabel(category)} cannot be a ${direction}. Choose a ${direction} category.`;
  }
  return undefined;
}

function parseId(id: unknown): number | null {
  if (id === null || id === undefined || id === '') return null;
  const n = typeof id === 'number' ? id : Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function validateManualTransaction(input: ManualTransactionInput, now: Date = new Date()): ValidationResult {
  const errors: FieldErrors = {};

  if (!isManualTransactionType(input.type)) {
    errors.type = 'Unsupported transaction type.';
    return { ok: false, errors };
  }

  const amountError = validateAmount(input.amount);
  if (amountError) errors.amount = amountError;

  const dateError = validateDate(input.date, now);
  if (dateError) errors.date = dateError;

  const noteError = validateNote(input.note);
  if (noteError) errors.note = noteError;

  const fromPartnerId = parseId(input.from_partner_id);
  const toPartnerId = parseId(input.to_partner_id);

  if (input.type === MANUAL_TRANSACTION_TYPES.PARTNER_TO_PARTNER) {
    if (!fromPartnerId) errors.from_partner_id = 'Select the partner sending the money.';
    if (!toPartnerId) errors.to_partner_id = 'Select the partner receiving the money.';
    if (fromPartnerId && toPartnerId && fromPartnerId === toPartnerId) {
      errors.to_partner_id = 'A partner cannot transfer money to themselves.';
    }
  } else if (!fromPartnerId === !toPartnerId) {
    // RECORD_AMOUNT is a credit (to only) or a debit (from only) — never both, never neither.
    errors.to_partner_id = 'Record Amount must credit or debit exactly one partner.';
  }

  const isRecordAmount = input.type === MANUAL_TRANSACTION_TYPES.RECORD_AMOUNT;
  if (isRecordAmount) {
    // Only check the direction once exactly one partner is set (otherwise that error shows).
    const direction = !fromPartnerId === !toPartnerId ? null : recordAmountDirection(fromPartnerId, toPartnerId);
    const categoryError = validateRecordAmountCategory(input.category, direction);
    if (categoryError) errors.category = categoryError;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      type: input.type,
      amount: parseAmount(input.amount) as number,
      date: parseTransactionDate(input.date) as Date,
      note: normalizeNote(input.note),
      fromPartnerId,
      toPartnerId,
      category: isRecordAmount ? (input.category as RecordAmountCategory) : null,
    },
  };
}

/** First error message, for APIs/toasts that show a single line. */
export function firstError(errors: FieldErrors): string {
  return Object.values(errors).find(Boolean) || 'Invalid transaction.';
}
