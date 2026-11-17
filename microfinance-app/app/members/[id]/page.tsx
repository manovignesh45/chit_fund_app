'use client';

/**
 * Member detail (Detail template): header, key-figure strip, tabs in ?tab=, panels.
 *
 * Tabs: overview (default) · dues · chit-funds · loans · timeline. Old links still work:
 * ?tab=details opens Overview and ?tab=payments opens Timeline (rewritten once, with replace).
 *
 * Requests on view, in parallel and often already preloaded from the list row (prefetchMember):
 * the member, their dues (overdue + next 30 days) and the Overview summary (action=summary:
 * lifetime money in/out, profit earned, one card per chit membership and per loan). The
 * Timeline (action=timeline: every event of the member, paged in the database) loads when its
 * tab is first opened; its page and filters live in the URL (page, pageSize, kind, account) and
 * the next page is preloaded when idle. Edit opens the shared member form in a dialog.
 */
import * as React from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  FileDown,
  Gavel,
  HandCoins,
  Pencil,
  PiggyBank,
  Plus,
  RefreshCw,
  Scale,
  ShieldAlert,
  Trash2,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

import { toast } from '@/lib/toast';
import DueAccountCard from '@/app/components/dues/DueAccountCard';
import SwipeableTabs from '@/app/components/SwipeableTabs';
import { useListParams } from '@/lib/list/useListParams';
import { normaliseListResponse, useListQuery } from '@/lib/list/useListQuery';
import { queryKeys } from '@/lib/query/keys';
import { prefetchQuery, whenIdle } from '@/lib/query/prefetch';
import { ApiError } from '@/lib/query/fetcher';
import {
  invalidateDeletedMember,
  MEMBERS,
  memberWrites,
  useMember,
  useMemberDues,
  useMemberSummary,
  type MemberChitMembership,
  type MemberDetail,
  type MemberDues,
  type MemberLoan,
  type MemberSummary,
  type MemberSummaryChit,
  type MemberSummaryLoan,
  type MemberTimelineItem,
  type TimelineEventKind,
} from '@/lib/query/members';
import { formatDate, formatMoney, toIsoDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useBreadcrumbLabel } from '@/components/kit/app-shell/breadcrumb-labels';
import { DataTable, RefreshProgress, type DataTableColumn } from '@/components/kit/data-table';
import { DateText } from '@/components/kit/date-text';
import { DescriptionList } from '@/components/kit/description-list';
import { EmptyState } from '@/components/kit/empty-state';
import { ErrorState, errorMessage } from '@/components/kit/error-state';
import { FilterChips } from '@/components/kit/filter-chips';
import { formatRange, ListPagination } from '@/components/kit/list-pagination';
import { Money } from '@/components/kit/money';
import { NativeSelect } from '@/components/kit/native-select';
import { PageContainer } from '@/components/kit/page-container';
import { iconOnPhone, PageHeader } from '@/components/kit/page-header';
import { RowActions, type RowAction } from '@/components/kit/row-actions';
import { SectionCard } from '@/components/kit/section-card';
import { StatCard } from '@/components/kit/stat-card';
import { StatusBadge } from '@/components/kit/status-badge';
import { UrlTabs, useUrlTabs } from '@/components/kit/url-tabs';

const MemberFormDialog = dynamic(() => import('@/app/components/members/MemberForm'), { ssr: false });

const TABS = ['overview', 'dues', 'chit-funds', 'loans', 'timeline'] as const;
type Tab = (typeof TABS)[number];
const NON_RECOVERABLE = 'Non-Recoverable';

/** Tab names of the old page (bookmarks, history): details → overview (the default), payments → timeline. */
const LEGACY_TABS: Record<string, Tab> = { details: 'overview', payments: 'timeline' };
/** The old payments filter's kinds, as timeline kinds. */
const LEGACY_KINDS: Record<string, string> = { contribution: 'chit', repayment: 'loan' };

/**
 * Rewrite an old ?tab= link (and its payment filter) once, in place, so the right tab opens.
 * history.replaceState (which Next keeps in sync with useSearchParams, so the URL tabs and list
 * params follow) rather than router.replace, which would re-render the page through its loading
 * fallback.
 */
function useLegacyTabLinks() {
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const tab = url.searchParams.get('tab') ?? '';
    if (!Object.prototype.hasOwnProperty.call(LEGACY_TABS, tab)) return;
    const next = LEGACY_TABS[tab];
    if (next === 'overview') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    const kind = url.searchParams.get('kind') ?? '';
    if (Object.prototype.hasOwnProperty.call(LEGACY_KINDS, kind)) url.searchParams.set('kind', LEGACY_KINDS[kind]);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
}

function DetailSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-11 w-full max-w-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export default function MemberDetailPage() {
  return (
    <PageContainer fallback={<DetailSkeleton />}>
      <MemberDetailView />
    </PageContainer>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function MemberDetailView() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10) || 0;
  const router = useRouter();
  const memberQuery = useMember(id || null);
  const duesQuery = useMemberDues(id || null);
  const summaryQuery = useMemberSummary(id || null);
  const member = memberQuery.data;
  const dues = duesQuery.data;
  useBreadcrumbLabel(id ? `/members/${id}` : null, member?.name);

  useLegacyTabLinks();
  const tabs = useUrlTabs<Tab>({ values: TABS, defaultValue: 'overview' });
  const [visited, setVisited] = React.useState<ReadonlySet<Tab>>(() => new Set<Tab>(['overview']));
  React.useEffect(() => {
    setVisited((prev) => (prev.has(tabs.value) ? prev : new Set([...prev, tabs.value])));
  }, [tabs.value]);

  const [editOpen, setEditOpen] = React.useState<boolean | null>(null);
  const [exporting, setExporting] = React.useState(false);

  if (!member) {
    if (memberQuery.error) {
      const status = memberQuery.error instanceof ApiError ? memberQuery.error.status : 0;
      if (status === 404 || status === 403 || status === 400) {
        return (
          <EmptyState
            title="Member not found"
            description="The member you are looking for does not exist or has been removed."
            action={
              <Button size="sm" variant="outline" asChild>
                <Link href="/members">Back to members</Link>
              </Button>
            }
          />
        );
      }
      return <ErrorState title="Couldn't load this member" error={memberQuery.error} onRetry={() => void memberQuery.mutate()} />;
    }
    return <DetailSkeleton />;
  }

  const exportMember = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await memberWrites.exportMembers([member.id]);
    } catch (error) {
      toast.error('Export failed', { description: errorMessage(error) ?? 'Failed to export member' });
    } finally {
      setExporting(false);
    }
  };

  const deleteMember = async () => {
    try {
      await memberWrites.remove(member.id);
    } catch (error) {
      toast.error(`Couldn't delete ${member.name}`, { description: errorMessage(error) ?? 'Failed to delete member.' });
      return;
    }
    toast.success('Member deleted', { description: member.name });
    const { forget } = invalidateDeletedMember(member.id);
    router.push('/members');
    whenIdle(forget);
  };

  const menu: RowAction[] = [
    { label: 'Export to Excel', icon: FileDown, onSelect: () => void exportMember(), disabled: exporting },
    { label: 'Assign to chit fund', icon: UserPlus, href: `/members/${member.id}/assign-chit-fund` },
    { label: 'New loan', icon: HandCoins, href: `/loans/new?borrowerId=${member.id}` },
    {
      label: 'Delete member',
      icon: Trash2,
      destructive: true,
      separatorBefore: true,
      confirm: {
        title: `Delete ${member.name}?`,
        description:
          'This action cannot be undone. Members associated with chit funds or loans cannot be deleted: remove them from all chit funds and loans first.',
        confirmLabel: 'Delete member',
        onConfirm: deleteMember,
      },
    },
  ];

  const summary = dues?.summary;
  const duesLoading = !dues && !duesQuery.error;
  const panel = (tab: Tab, children: React.ReactNode) => {
    const active = tabs.value === tab;
    return (
      <div
        role="tabpanel"
        id={tabs.panelId(tab)}
        aria-labelledby={tabs.tabId(tab)}
        className={cn(!active && 'lg:h-0 lg:overflow-hidden')}
        {...({ inert: active ? undefined : true } as Record<string, unknown>)}
      >
        {children}
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow={`Member #${member.id}`}
        title={member.name}
        description={
          <>
            <span className="tabular-nums">{member.contact}</span>
            {' · '}
            {plural(member._count.chitFundMembers, 'chit fund')} · {plural(member._count.loans, 'loan')}
          </>
        }
        actions={
          <>
            <Button className={iconOnPhone} variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil aria-hidden="true" />
              <span className="max-sm:sr-only">Edit</span>
            </Button>
            <RowActions label="More member actions" actions={menu} />
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Overdue"
          icon={AlertTriangle}
          loading={duesLoading}
          tone={(summary?.overdueAmount ?? 0) > 0 ? 'destructive' : 'neutral'}
          value={summary ? <Money value={summary.overdueAmount} tone="plain" /> : '—'}
          hint={summary ? plural(summary.overdueAccounts, 'account') : undefined}
          onClick={() => tabs.setValue('dues')}
        />
        <StatCard
          label="Due in next 7 days"
          icon={CalendarClock}
          loading={duesLoading}
          tone={(summary?.dueSoonAmount ?? 0) > 0 ? 'warning' : 'neutral'}
          value={summary ? <Money value={summary.dueSoonAmount} tone="plain" /> : '—'}
          hint="Includes today"
          onClick={() => tabs.setValue('dues')}
        />
        <StatCard
          label="Total outstanding"
          icon={Wallet}
          loading={duesLoading}
          value={summary ? <Money value={summary.totalOutstanding} tone="plain" /> : '—'}
          hint="Overdue + next 30 days"
          onClick={() => tabs.setValue('dues')}
        />
        <StatCard
          label="Last payment"
          icon={HandCoins}
          loading={duesLoading}
          value={dues?.lastPayment ? <Money value={dues.lastPayment.amount} tone="plain" /> : dues ? 'None' : '—'}
          hint={dues?.lastPayment ? <DateText value={dues.lastPayment.date} /> : undefined}
          onClick={() => tabs.setValue('timeline')}
        />
      </div>

      <UrlTabs
        tabs={tabs}
        aria-label="Member sections"
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'dues', label: 'Dues', count: dues ? dues.accounts.length : undefined },
          { value: 'chit-funds', label: 'Chit funds', count: member._count.chitFundMembers },
          { value: 'loans', label: 'Loans', count: member._count.loans },
          { value: 'timeline', label: 'Timeline' },
        ]}
      />

      <SwipeableTabs tabs={TABS} activeTab={tabs.value} onTabChange={tabs.setValue}>
        {panel(
          'overview',
          <OverviewPanel
            member={member}
            summary={summaryQuery.data}
            error={summaryQuery.error}
            retrying={summaryQuery.isValidating}
            onRetry={() => void summaryQuery.mutate()}
          />
        )}
        {panel('dues', <DuesPanel dues={dues} error={duesQuery.error} validating={duesQuery.isValidating} onRefresh={() => void duesQuery.mutate()} />)}
        {panel('chit-funds', <ChitFundsPanel member={member} />)}
        {panel('loans', <LoansPanel member={member} dues={dues} onShowDues={() => tabs.setValue('dues')} />)}
        {panel(
          'timeline',
          visited.has('timeline') ? (
            <TimelinePanel member={member} />
          ) : (
            <SectionCard title="Timeline">
              <Skeleton className="h-40 w-full" />
            </SectionCard>
          )
        )}
      </SwipeableTabs>

      {editOpen !== null ? <MemberFormDialog open={editOpen} onOpenChange={setEditOpen} member={member} /> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── dues

function DuesPanel({ dues, error, validating, onRefresh }: { dues: MemberDues | undefined; error: unknown; validating: boolean; onRefresh: () => void }) {
  return (
    <SectionCard
      title="Pending dues"
      description="Unpaid loan installments and chit contributions — overdue and due in the next 30 days."
      actions={
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={validating}>
          <RefreshCw aria-hidden="true" className={cn(validating && 'motion-safe:animate-spin')} />
          {validating ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
      contentClassName="p-3 sm:p-4"
    >
      {error && !dues ? (
        <ErrorState compact title="Couldn't load pending dues" error={error} onRetry={onRefresh} />
      ) : !dues ? (
        <div className="space-y-2" aria-hidden="true">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : dues.accounts.length === 0 ? (
        <EmptyState compact title="All caught up" description="Nothing overdue or due in the next 30 days." />
      ) : (
        <ul className={cn('space-y-2 transition-opacity', validating && 'opacity-60')} aria-busy={validating || undefined}>
          {dues.accounts.map((a) => (
            <DueAccountCard key={a.key} account={a} showMember={false} defaultOpen={dues.accounts.length === 1} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────── chit funds

function ChitFundsPanel({ member }: { member: MemberDetail }) {
  const columns: DataTableColumn<MemberChitMembership>[] = [
    {
      id: 'name',
      header: 'Chit fund',
      cell: (m) => (
        <Link href={`/chit-funds/${m.chitFund.id}`} className="font-medium text-foreground hover:text-primary-text hover:underline">
          {m.chitFund.name}
        </Link>
      ),
    },
    { id: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.chitFund.status} /> },
    {
      id: 'progress',
      header: 'Progress',
      cell: (m) => (
        <span className="whitespace-nowrap tabular-nums">
          Month {m.chitFund.currentMonth} <span className="text-muted-foreground">of {m.chitFund.duration}</span>
        </span>
      ),
    },
    { id: 'contribution', header: 'Contribution', numeric: true, cell: (m) => <Money value={m.contribution} tone="plain" /> },
    { id: 'missed', header: 'Missed', numeric: true, cell: (m) => <MissedCell m={m} /> },
    { id: 'pending', header: 'Pending amount', numeric: true, cell: (m) => <PendingCell m={m} /> },
    { id: 'joinDate', header: 'Join date', hideBelow: 'xl', cell: (m) => <DateText value={m.joinDate} /> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (m) => (
        <Link href={`/chit-funds/${m.chitFund.id}/members/${m.id}/contributions`} className="whitespace-nowrap text-sm font-medium text-primary-text hover:underline">
          View contributions
        </Link>
      ),
    },
  ];
  return (
    <SectionCard
      title={`Chit funds (${member._count.chitFundMembers})`}
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link href={`/members/${member.id}/assign-chit-fund`}>
            <Plus aria-hidden="true" />
            Assign to chit fund
          </Link>
        </Button>
      }
      flush
      contentClassName="p-3 sm:p-4"
    >
      <DataTable<MemberChitMembership>
        label="Chit fund memberships"
        mode="client"
        columns={columns}
        rows={member.chitFundMembers}
        getRowId={(m) => m.id}
        emptyState={<EmptyState compact title="Not in any chit fund" description="This member is not part of any chit funds yet." />}
        renderCard={(m) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/chit-funds/${m.chitFund.id}`} className="font-medium text-foreground hover:underline">
                  {m.chitFund.name}
                </Link>
                <div className="text-xs text-muted-foreground">
                  Month {m.chitFund.currentMonth} of {m.chitFund.duration} · joined <DateText value={m.joinDate} />
                </div>
              </div>
              <StatusBadge status={m.chitFund.status} />
            </div>
            <dl className="grid grid-cols-3 gap-x-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Contribution</dt>
                <dd><Money value={m.contribution} tone="plain" /></dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Missed</dt>
                <dd><MissedCell m={m} /></dd>
              </div>
              <div className="text-right">
                <dt className="text-xs text-muted-foreground">Pending</dt>
                <dd><PendingCell m={m} /></dd>
              </div>
            </dl>
            <Link href={`/chit-funds/${m.chitFund.id}/members/${m.id}/contributions`} className="inline-flex min-h-11 items-center text-sm font-medium text-primary-text hover:underline">
              View contributions
            </Link>
          </div>
        )}
      />
    </SectionCard>
  );
}

function MissedCell({ m }: { m: MemberChitMembership }) {
  const missed = m.missedContributions ?? 0;
  return (
    <div>
      <span className={cn('tabular-nums', missed > 0 && 'font-semibold text-destructive-text')}>{missed}</span>
      {(m.pendingMonths?.length ?? 0) > 0 ? <div className="text-xs text-muted-foreground">Months: {m.pendingMonths!.join(', ')}</div> : null}
    </div>
  );
}

function PendingCell({ m }: { m: MemberChitMembership }) {
  const partial = m.partialMonths ?? [];
  return (
    <div>
      <Money value={m.pendingAmount ?? 0} tone="overdue" className="font-semibold" />
      {partial.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          Incl. <Money value={partial.reduce((sum, p) => sum + p.balance, 0)} tone="plain" /> balance ({partial.map((p) => `Month ${p.month}`).join(', ')})
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── loans

function LoansPanel({ member, dues, onShowDues }: { member: MemberDetail; dues: MemberDues | undefined; onShowDues: () => void }) {
  const nonRecoverable = member.loans.filter((l) => l.status === NON_RECOVERABLE);
  const routine = member.loans.filter((l) => l.status !== NON_RECOVERABLE);

  const pendingCell = (loan: MemberLoan) => {
    if (!dues) return <span className="text-muted-foreground">…</span>;
    const acct = dues.accounts.find((a) => a.kind === 'loan' && a.entityId === loan.id);
    if (!acct) return <span className="text-muted-foreground">—</span>;
    return (
      <button type="button" onClick={onShowDues} className="rounded-sm text-right hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Money value={acct.totalOutstanding} tone={acct.overdueAmount > 0 ? 'overdue' : 'plain'} className="font-semibold" />
        <span className="block text-xs text-muted-foreground">
          {plural(acct.periods.length, 'payment')}
          {acct.maxDaysOverdue > 0 ? ` · ${acct.maxDaysOverdue}d late` : ''}
        </span>
      </button>
    );
  };
  const nextDue = (loan: MemberLoan) =>
    loan.nextPaymentDate ? (
      <DateText
        value={loan.nextPaymentDate}
        className={cn(loan.status === 'Active' && new Date(loan.nextPaymentDate) < new Date() && 'font-semibold text-destructive-text')}
      />
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  const installment = (loan: MemberLoan) => (loan.loanType === 'Reducing Balance' ? 'Dynamic' : <Money value={loan.installmentAmount || 0} tone="plain" />);

  const columns: DataTableColumn<MemberLoan>[] = [
    {
      id: 'loanType',
      header: 'Loan',
      cell: (loan) => (
        <Link href={`/loans/${loan.id}`} className="font-medium text-foreground hover:text-primary-text hover:underline">
          {loan.loanType}
          <span className="block text-xs font-normal text-muted-foreground">#{loan.id}</span>
        </Link>
      ),
    },
    { id: 'amount', header: 'Amount', numeric: true, cell: (loan) => <Money value={loan.amount} tone="plain" /> },
    { id: 'remaining', header: 'Remaining', numeric: true, cell: (loan) => <Money value={loan.remainingAmount} tone="plain" /> },
    { id: 'pending', header: 'Pending', numeric: true, cell: pendingCell },
    { id: 'overdue', header: 'Overdue', numeric: true, cell: (loan) => <Money value={loan.overdueAmount || 0} tone="overdue" className="font-semibold" /> },
    {
      id: 'missed',
      header: 'Missed',
      numeric: true,
      cell: (loan) => <span className={cn('tabular-nums', loan.missedPayments > 0 && 'font-semibold text-destructive-text')}>{loan.missedPayments || 0}</span>,
    },
    { id: 'nextDue', header: 'Next due', cell: nextDue },
    { id: 'installment', header: 'Installment', numeric: true, hideBelow: 'xl', cell: installment },
    { id: 'status', header: 'Status', cell: (loan) => <StatusBadge status={loan.status} /> },
    { id: 'disbursed', header: 'Disbursed', hideBelow: '2xl', cell: (loan) => <DateText value={loan.disbursementDate} /> },
  ];

  return (
    <SectionCard
      title={`Loans (${member._count.loans})`}
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link href={`/loans/new?borrowerId=${member.id}`}>
            <Plus aria-hidden="true" />
            Create new loan
          </Link>
        </Button>
      }
      flush
      contentClassName="p-3 sm:p-4"
    >
      {nonRecoverable.length > 0 ? (
        <section aria-labelledby="nr-loans" className="mb-4 rounded-lg border border-destructive-border bg-destructive-subtle/40 p-3 sm:p-4">
          <h3 id="nr-loans" className="text-sm font-semibold text-foreground">Non-Recoverable · Offline Recovery</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Excluded from this member’s routine pending dues.</p>
          <ul className="mt-3 space-y-3">
            {nonRecoverable.map((l) => (
              <li key={l.id} className="text-sm">
                <Link className="font-medium text-primary-text underline" href={`/loans/${l.id}#loan-recovery`}>
                  Loan #{l.id} · {l.loanType}
                </Link>
                <p className="text-foreground">
                  Principal <Money value={l.remainingAmount} tone="plain" /> · Unpaid interest <Money value={l.recoveryInterestOutstanding || 0} tone="plain" /> · Recovered{' '}
                  <Money value={l.recoveryAmount || 0} tone="plain" /> · {l.recoveryOutcome === 'Recovered' ? 'Fully Recovered' : l.recoveryOutcome}
                </p>
                <p className="text-xs text-muted-foreground">
                  Marked <DateText value={l.nonRecoverableAt} /> · {l.nonRecoverableReason}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <DataTable<MemberLoan>
        label="Loans"
        mode="client"
        columns={columns}
        rows={routine}
        getRowId={(loan) => loan.id}
        emptyState={<EmptyState compact title="No loans in routine collection." />}
        renderCard={(loan) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/loans/${loan.id}`} className="font-medium text-foreground hover:underline">
                  {loan.loanType} · <Money value={loan.amount} tone="plain" />
                </Link>
                <div className="text-xs text-muted-foreground">
                  #{loan.id} · disbursed <DateText value={loan.disbursementDate} />
                </div>
              </div>
              <StatusBadge status={loan.status} />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Remaining</dt>
                <dd><Money value={loan.remainingAmount} tone="plain" /></dd>
              </div>
              <div className="text-right">
                <dt className="text-xs text-muted-foreground">Pending</dt>
                <dd>{pendingCell(loan)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Overdue</dt>
                <dd>
                  <Money value={loan.overdueAmount || 0} tone="overdue" />
                  {loan.missedPayments > 0 ? <span className="ml-1 text-xs text-destructive-text">({loan.missedPayments} missed)</span> : null}
                </dd>
              </div>
              <div className="text-right">
                <dt className="text-xs text-muted-foreground">Next due</dt>
                <dd>{nextDue(loan)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Installment</dt>
                <dd>{installment(loan)}</dd>
              </div>
            </dl>
          </div>
        )}
      />
    </SectionCard>
  );
}


// ─────────────────────────────────────────────────────────────── overview

const CHIT_PROFIT_NOTE =
  'Chit commission is credited only on auctions this member won, once the fund has reached that month and the auction date has passed. A member who has not won yet shows ₹0 chit profit.';

function OverviewPanel({
  member,
  summary,
  error,
  retrying,
  onRetry,
}: {
  member: MemberDetail;
  summary: MemberSummary | undefined;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const details = (className?: string) => <MemberDetailsCard member={member} summary={summary} loading={!summary && !error} className={className} />;
  if (!summary) {
    return (
      <div className="space-y-6">
        {error ? <ErrorState title="Couldn't load this member's money summary" error={error} onRetry={onRetry} retrying={retrying} /> : <OverviewSkeleton />}
        {details()}
      </div>
    );
  }
  const t = summary.totals;
  const signTone = (n: number) => (n > 0 ? 'success' : n < 0 ? 'destructive' : 'neutral');
  return (
    <div className="space-y-6">
      <section aria-labelledby="member-lifetime-money">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id="member-lifetime-money" className="text-base font-semibold text-foreground">
            Lifetime money
          </h2>
          <p className="text-xs text-muted-foreground">
            All recorded payments · as of <DateText value={summary.asOf} />
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Money in"
            icon={ArrowDownLeft}
            tone={t.moneyIn > 0 ? 'success' : 'neutral'}
            value={<Money value={t.moneyIn} tone="plain" compact />}
            hint={`Contributions ${formatMoney(t.contributionsPaid)} · Repayments ${formatMoney(t.repaymentsReceived)}`}
          />
          <StatCard
            label="Money out"
            icon={ArrowUpRight}
            tone={t.moneyOut > 0 ? 'destructive' : 'neutral'}
            value={<Money value={t.moneyOut} tone="plain" compact />}
            hint={`Loans ${formatMoney(t.loanPrincipalOut - t.documentCharges)} · Auction payouts ${formatMoney(t.auctionPayoutsOut)}`}
          />
          <StatCard
            label="Net cash flow"
            icon={Scale}
            tone={signTone(t.netCashFlow)}
            value={<Money value={t.netCashFlow} tone="plain" compact />}
            hint="Positive = member has paid in more than they received"
          />
          <StatCard
            label="Profit earned"
            icon={TrendingUp}
            tone={signTone(t.profit)}
            value={<Money value={t.profit} tone="plain" compact />}
            hint={`Loans ${formatMoney(t.loanProfit)} · Chit ${formatMoney(t.chitCommission)}`}
          />
        </div>
        {t.documentCharges > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Loans out is the cash handed over: principal {formatMoney(t.loanPrincipalOut)} less {formatMoney(t.documentCharges)} document charges withheld.
          </p>
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <ProfitBreakdown summary={summary} className="lg:col-span-3" />
        {details('lg:col-span-2')}
      </div>

      <SectionCard title={`Chit funds (${summary.chits.length})`} contentClassName="p-3 sm:p-4" flush>
        {summary.chits.length === 0 ? (
          <EmptyState compact title="Not in any chit fund" description="This member is not part of any chit funds yet." />
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {summary.chits.map((c) => (
              <ChitSummaryCard key={c.membershipId} chit={c} />
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title={`Loans (${summary.loans.length})`} contentClassName="p-3 sm:p-4" flush>
        {summary.loans.length === 0 ? (
          <EmptyState compact title="No loans" description="This member has not taken a loan yet." />
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {summary.loans.map((l) => (
              <LoanSummaryCard key={l.id} loan={l} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-6">
      <Skeleton className="h-5 w-40" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}

function MemberDetailsCard({
  member,
  summary,
  loading,
  className,
}: {
  member: MemberDetail;
  summary: MemberSummary | undefined;
  loading: boolean;
  className?: string;
}) {
  const keyDate = (value: string | null | undefined, none: string) =>
    loading ? <Skeleton className="h-4 w-24" /> : summary ? <DateText value={value} fallback={none} /> : '—';
  return (
    <SectionCard title="Member details" className={className}>
      <DescriptionList
        columns={2}
        items={[
          { label: 'Name', value: member.name },
          { label: 'Contact', value: <span className="tabular-nums">{member.contact}</span> },
          { label: 'Email', value: member.email || '—' },
          { label: 'Address', value: member.address || '—' },
          { label: 'Member since', value: <DateText value={member.createdAt} /> },
          { label: 'First activity', value: keyDate(summary?.keyDates.firstActivity, 'None yet') },
          { label: 'Last payment', value: keyDate(summary?.keyDates.lastPayment, 'None yet') },
          ...(member.notes ? [{ label: 'Notes', value: <span className="whitespace-pre-line">{member.notes}</span>, full: true }] : []),
        ]}
      />
    </SectionCard>
  );
}

interface ProfitRow {
  key: string;
  href: string;
  account: string;
  date: string;
  how: string;
  amount: number;
}

function profitRows(summary: MemberSummary): ProfitRow[] {
  const rows: ProfitRow[] = summary.loans.map((l) => ({
    key: `loan-${l.id}`,
    href: `/loans/${l.id}`,
    account: `Loan #${l.id} · ${l.loanType}`,
    date: l.disbursementDate,
    how: l.recovery ? 'Interest, document charge and recovered interest' : l.documentCharge > 0 ? 'Interest and document charge' : 'Interest',
    amount: l.profit,
  }));
  for (const c of summary.chits) {
    if (!c.won) continue;
    rows.push({
      key: `chit-${c.membershipId}`,
      href: `/chit-funds/${c.fundId}`,
      account: c.name,
      date: c.won.date,
      how: c.won.counted ? `Commission on the month ${c.won.month} auction` : `Month ${c.won.month} auction · commission not counted yet`,
      amount: c.won.commission,
    });
  }
  return rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function ProfitBreakdown({ summary, className }: { summary: MemberSummary; className?: string }) {
  const rows = profitRows(summary);
  const columns: DataTableColumn<ProfitRow>[] = [
    {
      id: 'account',
      header: 'Account',
      cell: (r) => (
        <Link href={r.href} className="font-medium text-foreground hover:text-primary-text hover:underline">
          {r.account}
          <span className="block text-xs font-normal text-muted-foreground">
            <DateText value={r.date} />
          </span>
        </Link>
      ),
    },
    { id: 'how', header: 'How it was earned', cell: (r) => <span className="text-muted-foreground">{r.how}</span> },
    { id: 'amount', header: 'Profit', numeric: true, cell: (r) => <Money value={r.amount} tone="plain" className="font-semibold" /> },
  ];
  return (
    <SectionCard
      title="Profit earned"
      description={`Loans ${formatMoney(summary.totals.loanProfit)} · Chit commission ${formatMoney(summary.totals.chitCommission)}`}
      className={className}
      flush
      contentClassName="p-3 sm:p-4"
      footer={
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium text-foreground">Total profit</span>
          <Money value={summary.totals.profit} tone="plain" className="font-semibold" />
        </div>
      }
    >
      <DataTable<ProfitRow>
        label="Profit by account"
        mode="client"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.key}
        emptyState={
          <EmptyState
            compact
            title="No profit yet"
            description="Profit comes from loan interest and document charges, and from the commission on chit auctions this member wins."
          />
        }
        renderCard={(r) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link href={r.href} className="inline-flex min-h-11 items-center font-medium text-foreground hover:underline">
                {r.account}
              </Link>
              <p className="text-xs text-muted-foreground">
                <DateText value={r.date} /> · {r.how}
              </p>
            </div>
            <Money value={r.amount} tone="plain" className="pt-3 font-semibold" />
          </div>
        )}
      />
      <p className="mt-3 px-1 text-xs text-muted-foreground">{CHIT_PROFIT_NOTE}</p>
    </SectionCard>
  );
}

function SummaryCardHeader({ href, title, sub, status }: { href: string; title: string; sub: React.ReactNode; status: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <Link href={href} className="inline-flex min-h-11 items-center font-medium text-foreground hover:text-primary-text hover:underline sm:min-h-0">
          {title}
        </Link>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

function ChitSummaryCard({ chit: c }: { chit: MemberSummaryChit }) {
  return (
    <li className="rounded-lg border bg-card p-4">
      <SummaryCardHeader href={`/chit-funds/${c.fundId}`} title={c.name} status={c.status} sub={<>Joined <DateText value={c.joinDate} /></>} />
      <DescriptionList
        className="mt-3"
        columns={2}
        items={[
          { label: 'Monthly', value: <Money value={c.monthlyContribution} tone="plain" />, numeric: true },
          {
            label: 'Paid so far',
            value: <Money value={c.contributionsPaid} tone="plain" />,
            numeric: true,
            hint: c.duration ? `${c.monthsPaid} of ${c.duration} months` : plural(c.monthsPaid, 'month'),
          },
        ]}
      />
      <div className="mt-3 border-t pt-3">
        {c.won ? (
          <>
            <StatusBadge status={c.won.counted ? 'Paid' : 'Pending'} label={`Won month ${c.won.month} on ${formatDate(c.won.date)}`} />
            <DescriptionList
              className="mt-3"
              columns={3}
              items={[
                { label: 'Payout', value: <Money value={c.won.payout} tone="plain" />, numeric: true },
                { label: 'Discount', value: <Money value={c.won.discount} tone="plain" />, numeric: true, hint: `${c.won.discountPct}%` },
                {
                  label: 'Commission',
                  value: <Money value={c.won.commission} tone="plain" className={cn(c.won.commission > 0 && 'text-success-text')} />,
                  numeric: true,
                },
              ]}
            />
            {!c.won.counted ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Commission not counted yet: it is credited once the fund reaches month {c.won.month} and the auction date has passed.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <StatusBadge status="Pending" label="Not won yet" />
            <p className="mt-2 text-xs text-muted-foreground">No chit commission from this membership until it wins an auction.</p>
          </>
        )}
      </div>
    </li>
  );
}

const OUTCOME_LABELS: Record<string, string> = { Recovered: 'Fully recovered', Settled: 'Settled', Open: 'Recovery open' };

function LoanSummaryCard({ loan: l }: { loan: MemberSummaryLoan }) {
  const r = l.recovery;
  return (
    <li className="rounded-lg border bg-card p-4">
      <SummaryCardHeader
        href={`/loans/${l.id}`}
        title={`Loan #${l.id} · ${l.loanType}`}
        status={l.status}
        sub={<>Disbursed <DateText value={l.disbursementDate} /></>}
      />
      <DescriptionList
        className="mt-3"
        columns={3}
        items={[
          { label: 'Principal', value: <Money value={l.principal} tone="plain" />, numeric: true },
          { label: 'Document charge', value: <Money value={l.documentCharge} tone="plain" />, numeric: true },
          { label: 'Repaid', value: <Money value={l.totalRepaid} tone="plain" />, numeric: true, hint: plural(l.installmentsPaid, 'installment') },
          {
            label: 'Profit',
            value: <Money value={l.profit} tone="plain" className={cn(l.profit > 0 && 'text-success-text')} />,
            numeric: true,
          },
          {
            label: 'Remaining',
            value: <Money value={l.remainingAmount} tone="plain" />,
            numeric: true,
          },
          { label: 'Last repayment', value: <DateText value={l.lastRepaymentDate} fallback="None yet" /> },
        ]}
      />
      {r ? (
        <div className="mt-3 rounded-md border border-destructive-border bg-destructive-subtle/40 p-3">
          <p className="text-sm font-medium text-foreground">
            Offline recovery{r.outcome ? ` · ${OUTCOME_LABELS[r.outcome] ?? r.outcome}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            Marked non-recoverable <DateText value={r.markedAt} />
            {r.reason ? ` · ${r.reason}` : ''}
          </p>
          <DescriptionList
            className="mt-3"
            columns={2}
            items={[
              { label: 'Principal at mark', value: <Money value={r.principalAtMark} tone="plain" />, numeric: true },
              { label: 'Dues at mark', value: <Money value={r.duesAtMark} tone="plain" />, numeric: true },
              { label: 'Unpaid interest', value: <Money value={r.interestOutstanding} tone="plain" />, numeric: true },
              { label: 'Recovered', value: <Money value={r.recovered} tone="plain" />, numeric: true },
            ]}
          />
        </div>
      ) : null}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────── timeline

const TIMELINE_FILTERS = ['kind', 'account'] as const;
const KIND_OPTIONS = [
  { value: '', label: 'All events' },
  { value: 'chit', label: 'Chit funds' },
  { value: 'loan', label: 'Loans' },
  { value: 'money-in', label: 'Money in' },
  { value: 'money-out', label: 'Money out' },
];
const KIND_ICONS: Record<TimelineEventKind, LucideIcon> = {
  member_created: UserPlus,
  chit_joined: Users,
  contribution: PiggyBank,
  auction_won: Gavel,
  loan_disbursed: HandCoins,
  repayment: Wallet,
  recovery_event: ShieldAlert,
};

interface TimelineTotals {
  moneyIn: number;
  moneyOut: number;
}

function TimelinePanel({ member }: { member: MemberDetail }) {
  const list = useListParams<(typeof TIMELINE_FILTERS)[number]>({ id: 'member-timeline', filters: TIMELINE_FILTERS, defaults: { pageSize: 25 } });
  const query = useListQuery<MemberTimelineItem, TimelineTotals>(MEMBERS, list, {
    action: 'timeline',
    id: member.id,
    itemsKey: 'items',
    select: (raw, request) => {
      const body = raw as Partial<TimelineTotals> | null;
      return {
        ...normaliseListResponse<MemberTimelineItem>(raw, request, 'items'),
        summary: { moneyIn: Number(body?.moneyIn ?? 0), moneyOut: Number(body?.moneyOut ?? 0) },
      };
    },
  });
  const meta = query.meta;
  const kind = list.params.kind ?? '';

  // Preload the next page once this one has settled.
  React.useEffect(() => {
    if (!list.ready || !meta?.hasNext || query.isRefreshing) return;
    const next = queryKeys.action(MEMBERS, 'timeline', member.id, { ...list.apiParams, page: meta.page + 1 });
    return whenIdle(() => prefetchQuery(next));
  }, [list.ready, list.apiParams, meta, query.isRefreshing, member.id]);

  const chitOptions = Array.from(new Map(member.chitFundMembers.map((m) => [m.chitFund.id, m.chitFund.name])), ([fundId, name]) => ({
    value: `chit-${fundId}`,
    label: name,
  }));
  const loanOptions = member.loans.map((l) => ({ value: `loan-${l.id}`, label: `Loan #${l.id} · ${l.loanType}` }));
  const accountsFor = (k: string) => [...(k !== 'loan' ? chitOptions : []), ...(k !== 'chit' ? loanOptions : [])];
  const accountOptions = [{ value: '', label: 'All accounts' }, ...accountsFor(kind)];
  const accountLabel = (value: string) => [...chitOptions, ...loanOptions].find((o) => o.value === value)?.label ?? value;
  const chips = list.activeFilters.map((f) => ({
    key: f.name,
    label: f.name === 'kind' ? (KIND_OPTIONS.find((o) => o.value === f.value)?.label ?? f.value) : accountLabel(f.value),
    onRemove: () => list.setParams({ [f.name]: null } as Parameters<typeof list.setParams>[0]),
  }));
  const changeKind = (value: string) => {
    const account = list.params.account ?? null;
    const keep = account !== null && accountsFor(value).some((o) => o.value === account);
    list.setParams({ kind: value || null, account: keep ? account : null });
  };

  // Rows of this page under one heading per day (newest first, as the server orders them).
  const groups = React.useMemo(() => {
    const out: { day: string; items: MemberTimelineItem[] }[] = [];
    for (const item of query.items) {
      const day = toIsoDate(item.date) ?? '';
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(item);
      else out.push({ day, items: [item] });
    }
    return out;
  }, [query.items]);

  const totals = query.summary;
  let body: React.ReactNode;
  if (query.isInitialLoading) {
    body = (
      <ul aria-hidden="true" className="divide-y">
        {Array.from({ length: 5 }, (_, i) => (
          <li key={i} className="flex gap-3 px-4 py-3 sm:px-6">
            <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </li>
        ))}
      </ul>
    );
  } else if (query.error && query.items.length === 0) {
    body = (
      <div className="p-3 sm:p-4">
        <ErrorState compact title="Couldn't load the timeline" error={query.error} onRetry={() => void query.mutate()} />
      </div>
    );
  } else if (query.items.length === 0) {
    body = (
      <div className="p-3 sm:p-4">
        {list.isFiltered ? (
          <EmptyState compact variant="no-results" title="No events for this filter." description="Try another account or event type." onClearFilters={list.clearFilters} />
        ) : (
          <EmptyState compact title="Nothing recorded yet." description="Chit memberships, contributions, auctions, loans and repayments appear here." />
        )}
      </div>
    );
  } else {
    body = (
      <ol aria-label="Member timeline" className={cn('transition-opacity duration-150', query.isRefreshing && 'opacity-60')}>
        {groups.map((g) => (
          <li key={g.day}>
            <h3 className="border-y bg-muted/40 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:px-6">
              <DateText value={g.day} />
            </h3>
            <ul className="divide-y">
              {g.items.map((item) => (
                <TimelineRow key={item.key} item={item} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <SectionCard
      title="Timeline"
      description={
        meta && totals
          ? `${plural(meta.totalCount, 'event')} · ${formatMoney(totals.moneyIn)} in · ${formatMoney(totals.moneyOut)} out`
          : undefined
      }
      flush
    >
      <div className="space-y-3 px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="sm:w-44">
            <NativeSelect aria-label="Event type" value={kind} onValueChange={changeKind} options={KIND_OPTIONS} />
          </div>
          <div className="min-w-0 sm:w-64">
            <NativeSelect
              aria-label="Account"
              value={list.params.account ?? ''}
              onValueChange={(value) => list.setParams({ account: value || null })}
              options={accountOptions}
            />
          </div>
        </div>
        {chips.length > 0 || meta ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FilterChips chips={chips} onClearAll={list.clearFilters} />
            {meta && meta.totalCount > 0 ? (
              <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
                {formatRange(meta.page, meta.pageSize, meta.totalCount)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="relative border-t" aria-busy={query.isInitialLoading || query.isRefreshing || undefined}>
        <RefreshProgress active={query.isRefreshing} />
        {body}
      </div>
      {meta && meta.totalCount > 0 ? (
        <div className="border-t px-4 py-3 sm:px-6">
          <ListPagination
            page={meta.page}
            pageSize={list.params.pageSize}
            totalCount={meta.totalCount}
            onPageChange={(page) => list.setParams({ page })}
            onPageSizeChange={(pageSize) => list.setParams({ pageSize })}
            disabled={query.isRefreshing}
          />
        </div>
      ) : null}
    </SectionCard>
  );
}

const DIRECTION_ICON_CLASSES = {
  in: 'bg-success-subtle text-success-text',
  out: 'bg-destructive-subtle text-destructive-text',
  none: 'bg-muted text-muted-foreground',
} as const;

function TimelineRow({ item }: { item: MemberTimelineItem }) {
  const Icon = KIND_ICONS[item.kind] ?? CalendarClock;
  const content = (
    <div className="flex gap-3">
      <span aria-hidden="true" className={cn('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full', DIRECTION_ICON_CLASSES[item.direction])}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 font-medium text-foreground">{item.title}</p>
          {item.amount != null ? (
            item.direction === 'out' ? (
              <Money value={-item.amount} tone="auto" className="font-semibold" aria-label={`${formatMoney(item.amount)} paid out`} />
            ) : (
              <Money value={item.amount} tone={item.direction === 'in' ? 'inflow' : 'plain'} className="font-semibold" />
            )
          ) : null}
        </div>
        {item.accountName ? <p className="truncate text-sm text-muted-foreground">{item.accountName}</p> : null}
        {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
        {item.collectedBy ? (
          <p className="text-xs text-muted-foreground">
            {item.direction === 'out' ? 'Paid out by' : 'Collected by'} {item.collectedBy}
          </p>
        ) : null}
      </div>
    </div>
  );
  return (
    <li>
      {item.href ? (
        <Link
          href={item.href}
          className="block min-h-11 px-4 py-3 transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6"
        >
          {content}
        </Link>
      ) : (
        <div className="px-4 py-3 sm:px-6">{content}</div>
      )}
    </li>
  );
}
