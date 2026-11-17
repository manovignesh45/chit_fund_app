-- Category of a manual RECORD_AMOUNT ledger entry (opening balance, expense, other income, ...),
-- used by the tax report. Additive only: existing rows keep NULL and show as "Unclassified".
ALTER TABLE "Transaction" ADD COLUMN "category" TEXT;
