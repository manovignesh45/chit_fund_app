/**
 * Categories for manual RECORD_AMOUNT ledger entries. A credit (money in) has `to_partner_id`
 * set, a debit (money out) has `from_partner_id` set. Only EXPENSE and OTHER_INCOME reach the
 * profit & loss; every category has its own cash-flow line. An entry without a category is
 * "Unclassified": kept out of the P&L and flagged for the user to classify.
 *
 * Shared by server validation and the client form, so no React or Prisma imports.
 */

export const RECORD_AMOUNT_CATEGORY_VALUES = [
  'OPENING_BALANCE',
  'CAPITAL_IN',
  'OTHER_INCOME',
  'ADVANCE_RETURNED',
  'DRAWINGS',
  'EXPENSE',
  'ADVANCE_GIVEN',
  'CORRECTION',
] as const;

export type RecordAmountCategory = (typeof RECORD_AMOUNT_CATEGORY_VALUES)[number];
export type RecordAmountDirection = 'credit' | 'debit';
export type RecordAmountProfitAndLoss = 'income' | 'expense' | 'none';

export interface RecordAmountCategoryInfo {
  value: RecordAmountCategory;
  label: string;
  hint: string;
  directions: readonly RecordAmountDirection[];
  profitAndLoss: RecordAmountProfitAndLoss;
  cashFlowLabel: string;
}

export const RECORD_AMOUNT_CATEGORIES: readonly RecordAmountCategoryInfo[] = [
  { value: 'OPENING_BALANCE', label: 'Opening balance', hint: 'Money already held before it was entered in the app (old balances brought in).', directions: ['credit'], profitAndLoss: 'none', cashFlowLabel: 'Opening balance brought in' },
  { value: 'CAPITAL_IN', label: 'Capital introduced', hint: 'A partner puts new money into the business.', directions: ['credit'], profitAndLoss: 'none', cashFlowLabel: 'Capital introduced' },
  { value: 'OTHER_INCOME', label: 'Other income', hint: 'Income from outside chits and loans, such as rent.', directions: ['credit'], profitAndLoss: 'income', cashFlowLabel: 'Other income' },
  { value: 'ADVANCE_RETURNED', label: 'Advance returned', hint: 'An advance given earlier comes back.', directions: ['credit'], profitAndLoss: 'none', cashFlowLabel: 'Advances returned' },
  { value: 'DRAWINGS', label: 'Partner drawings', hint: 'A partner takes money out of the business.', directions: ['debit'], profitAndLoss: 'none', cashFlowLabel: 'Partner drawings' },
  { value: 'EXPENSE', label: 'Expense', hint: 'A running cost of the business: office, food, events.', directions: ['debit'], profitAndLoss: 'expense', cashFlowLabel: 'Expenses' },
  { value: 'ADVANCE_GIVEN', label: 'Advance given', hint: 'Money paid out that is to be repaid; not an expense.', directions: ['debit'], profitAndLoss: 'none', cashFlowLabel: 'Advances given' },
  { value: 'CORRECTION', label: 'Balance correction', hint: 'Fixes a recording mistake; neither income nor expense.', directions: ['credit', 'debit'], profitAndLoss: 'none', cashFlowLabel: 'Balance corrections' },
];

const BY_VALUE = new Map<string, RecordAmountCategoryInfo>(RECORD_AMOUNT_CATEGORIES.map((c) => [c.value, c]));

export function isRecordAmountCategory(value: unknown): value is RecordAmountCategory {
  return typeof value === 'string' && BY_VALUE.has(value);
}

export function categoryAllowsDirection(category: RecordAmountCategory, direction: RecordAmountDirection): boolean {
  return BY_VALUE.get(category)?.directions.includes(direction) ?? false;
}

/** Note patterns, checked in order; the first whose category allows the direction wins. */
const SUGGESTIONS: { pattern: RegExp; category: RecordAmountCategory }[] = [
  { pattern: /\bcorrection\b/, category: 'CORRECTION' },
  { pattern: /\bcapital\s+withdraw|\bdrawings?\b/, category: 'DRAWINGS' },
  { pattern: /\bcapital\b(?!\s+withdraw)/, category: 'CAPITAL_IN' },
  { pattern: /\badvance\b/, category: 'ADVANCE_GIVEN' },
  { pattern: /\badvance\b/, category: 'ADVANCE_RETURNED' },
  // "old amount reset", "tally old remaining balance", "previous … chit last amount", "old … last due".
  { pattern: /\bopening\b|\b(old|previous)\b.*\b(amount|balance|due|reset|remaining)\b/, category: 'OPENING_BALANCE' },
  { pattern: /\b(expenses?|food|party|sweets?|get[\s-]*to[\s-]*gether|snacks?|tea|office)\b/, category: 'EXPENSE' },
  { pattern: /\brent\b/, category: 'OTHER_INCOME' },
];

/** A best guess from the note text, for the user to confirm; null when nothing fits. */
export function suggestRecordAmountCategory(note: string | null | undefined, direction: RecordAmountDirection): RecordAmountCategory | null {
  const text = (note ?? '').toLowerCase();
  if (!text.trim()) return null;
  const match = SUGGESTIONS.find((s) => s.pattern.test(text) && categoryAllowsDirection(s.category, direction));
  return match ? match.category : null;
}
