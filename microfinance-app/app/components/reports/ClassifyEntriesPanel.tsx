'use client';

/**
 * "Entries to classify": the data owner's Record Amount entries that have no usable
 * category, each with a category select pre-filled with the suggestion from its note
 * (GET /api/transactions/classify). Nothing is saved until the user presses Save on a row
 * or confirms "Confirm all suggested". A saved entry leaves the list. Category changes
 * never touch amounts or balances (PATCH /api/transactions/classify).
 *
 * Embedded by the tax report page; `onChanged` runs after every successful save.
 */
import * as React from 'react';
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';

import { toast } from '@/lib/toast';
import { ApiError } from '@/lib/query/fetcher';
import {
  invalidateTransactionCategories,
  transactionWrites,
  useUnclassifiedEntries,
  type CategoryUpdate,
  type UnclassifiedEntry,
  type UnclassifiedEntriesResponse,
} from '@/lib/query/transactions';
import { categoryAllowsDirection, isRecordAmountCategory, RECORD_AMOUNT_CATEGORIES } from '@/lib/recordAmountCategories';
import { recordAmountCategoriesFor, recordAmountCategoryLabel } from '@/lib/transactionValidation';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/kit/confirm-dialog';
import { DateText } from '@/components/kit/date-text';
import { EmptyState } from '@/components/kit/empty-state';
import { ErrorState, errorMessage } from '@/components/kit/error-state';
import { FormField } from '@/components/kit/form-field';
import { Money } from '@/components/kit/money';
import { NativeSelect } from '@/components/kit/native-select';
import { SectionCard } from '@/components/kit/section-card';

export interface ClassifyEntriesPanelProps {
  /** Called after categories are saved (e.g. to refetch the report). */
  onChanged?: () => void;
  className?: string;
}

const hintOf = (value: string) => RECORD_AMOUNT_CATEGORIES.find((c) => c.value === value)?.hint ?? '';

export default function ClassifyEntriesPanel({ onChanged, className }: ClassifyEntriesPanelProps) {
  const query = useUnclassifiedEntries();
  const entries = query.data?.entries ?? [];

  // The user's pick per entry id; absent means "still the suggestion".
  const [choices, setChoices] = React.useState<Record<number, string>>({});
  const [saving, setSaving] = React.useState<Record<number, boolean>>({});
  const [rowErrors, setRowErrors] = React.useState<Record<number, string>>({});
  const [confirmAllOpen, setConfirmAllOpen] = React.useState(false);

  const choiceOf = (e: UnclassifiedEntry) => choices[e.id] ?? e.suggestedCategory ?? '';
  const anySaving = Object.values(saving).some(Boolean);
  const suggested = entries.filter((e) => e.suggestedCategory && choiceOf(e) === e.suggestedCategory);

  const save = async (items: CategoryUpdate[]) => {
    const ids = new Set(items.map((i) => i.id));
    const mark = (value: boolean) =>
      setSaving((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = value;
        return next;
      });
    mark(true);
    setRowErrors((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    try {
      await transactionWrites.setCategories(items);
      // Saved rows leave the list now; the refetch below confirms it.
      await query.mutate(
        (current: UnclassifiedEntriesResponse | undefined) =>
          current ? { entries: current.entries.filter((e) => !ids.has(e.id)), count: Math.max(0, current.count - ids.size) } : current,
        { revalidate: false }
      );
      setChoices((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      toast.success(items.length === 1 ? 'Category saved' : `${items.length} categories saved`);
      void invalidateTransactionCategories();
      onChanged?.();
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as { itemErrors?: Record<string, string> } | null) : null;
      const message = errorMessage(error) || 'Could not save the category.';
      // All or none: in a batch only the rows the server named are wrong (the dialog shows the rest).
      setRowErrors((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          const own = body?.itemErrors?.[id] ?? (items.length === 1 ? message : undefined);
          if (own) next[id] = own;
        }
        return next;
      });
      throw error;
    } finally {
      mark(false);
    }
  };

  const saveRow = (e: UnclassifiedEntry) => {
    const category = choiceOf(e);
    if (!isRecordAmountCategory(category)) {
      setRowErrors((prev) => ({ ...prev, [e.id]: 'Choose a category so this entry is reported on the right line.' }));
      return;
    }
    // The error is shown on the row.
    save([{ id: e.id, category }]).catch(() => undefined);
  };

  const confirmAll = async () => {
    const items = suggested.flatMap((e) => (isRecordAmountCategory(e.suggestedCategory) ? [{ id: e.id, category: e.suggestedCategory }] : []));
    if (items.length) await save(items);
  };

  let body: React.ReactNode;
  if (!query.data && query.error) {
    body = <ErrorState compact error={query.error} onRetry={() => void query.mutate()} retrying={query.isValidating} />;
  } else if (!query.data) {
    body = (
      <div className="space-y-4 p-4 sm:p-6" role="status" aria-label="Loading entries to classify">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
    );
  } else if (entries.length === 0) {
    body = (
      <EmptyState
        compact
        icon={CheckCircle2}
        title="Every entry is classified"
        description="New Record Amount entries get their category when they are recorded."
      />
    );
  } else {
    body = (
      <ul className="divide-y" aria-label="Entries to classify">
        {entries.map((e) => (
          <EntryRow
            key={e.id}
            entry={e}
            choice={choiceOf(e)}
            onChoice={(value) => {
              setChoices((prev) => ({ ...prev, [e.id]: value }));
              setRowErrors((prev) => {
                const next = { ...prev };
                delete next[e.id];
                return next;
              });
            }}
            onSave={() => saveRow(e)}
            saving={!!saving[e.id]}
            error={rowErrors[e.id]}
          />
        ))}
      </ul>
    );
  }

  return (
    <SectionCard
      className={className}
      flush
      title={`Entries to classify${entries.length ? ` (${entries.length})` : ''}`}
      description="Record Amount entries without a category are kept out of the profit & loss. Check each suggestion, change it if needed, and save."
      actions={
        suggested.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => setConfirmAllOpen(true)} disabled={anySaving}>
            Confirm all suggested ({suggested.length})
          </Button>
        ) : null
      }
    >
      {body}
      <ConfirmDialog
        open={confirmAllOpen}
        onOpenChange={setConfirmAllOpen}
        tone="default"
        title={`Save ${suggested.length} suggested ${suggested.length === 1 ? 'category' : 'categories'}?`}
        description="Each entry below gets the category suggested from its note. Entries where you picked a different category are not included: save those on their own row."
        confirmLabel={`Save ${suggested.length}`}
        onConfirm={confirmAll}
      >
        <ul className="max-h-60 divide-y overflow-y-auto rounded-md border text-sm">
          {suggested.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-3 px-3 py-2">
              <span className="min-w-0 break-words text-muted-foreground">{e.note || 'No reason recorded'}</span>
              <span className="shrink-0 font-medium text-foreground">{recordAmountCategoryLabel(e.suggestedCategory)}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </SectionCard>
  );
}

function EntryRow({
  entry: e,
  choice,
  onChoice,
  onSave,
  saving,
  error,
}: {
  entry: UnclassifiedEntry;
  choice: string;
  onChoice: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  error?: string;
}) {
  const credit = e.direction === 'credit';
  const isSuggestion = !!e.suggestedCategory && choice === e.suggestedCategory;
  const misfit = e.category && !(isRecordAmountCategory(e.category) && categoryAllowsDirection(e.category, e.direction));
  const selectId = `classify-${e.id}`;

  return (
    <li className="space-y-3 px-4 py-4 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            <DateText value={e.date} />
            <span className="text-muted-foreground"> · {e.partnerName || '—'}</span>
          </p>
          <p className="break-words text-sm text-muted-foreground">{e.note || <span className="italic">No reason recorded</span>}</p>
          {misfit ? (
            <p className="text-xs text-warning-text">
              Saved as “{recordAmountCategoryLabel(e.category)}”, which cannot be a {e.direction}.
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <Money value={e.amount} tone={credit ? 'inflow' : 'plain'} className="font-semibold" />
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{credit ? 'Credit' : 'Debit'}</div>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <FormField
          className="min-w-0 flex-1"
          id={selectId}
          label={
            <span className="inline-flex flex-wrap items-center gap-1.5">
              Category
              {isSuggestion ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-info-border bg-info-subtle px-2 py-0.5 text-[11px] font-medium text-info-text">
                  <Sparkles aria-hidden="true" className="h-3 w-3" />
                  Suggested, not saved
                </span>
              ) : null}
            </span>
          }
          error={error}
          description={choice ? hintOf(choice) : e.suggestedCategory ? undefined : 'No suggestion from the note. Choose one.'}
        >
          <NativeSelect
            value={choice}
            onValueChange={onChoice}
            disabled={saving}
            placeholder={`Choose a ${e.direction} category`}
            options={recordAmountCategoriesFor(e.direction).map((c) => ({ value: c.value, label: c.label }))}
          />
        </FormField>
        <Button className="w-full sm:mt-7 sm:w-auto" onClick={onSave} disabled={saving || !choice}>
          {saving ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : null}
          {saving ? 'Saving…' : isSuggestion ? 'Confirm' : 'Save'}
          <span className="sr-only"> category for entry #{e.id}</span>
        </Button>
      </div>
    </li>
  );
}
