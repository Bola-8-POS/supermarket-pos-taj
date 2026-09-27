import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PaymentForm } from '@widgets/PaymentModal';
import { EditPaidTabDialog } from '@features/edit-paid-tab';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import { RefundSheet } from '@features/process-refund';
import { ReopenTabDialog } from '@features/reopen-tab';
import { ReprintButton } from '@features/reprint-receipt';
import type { Payment } from '@entities/payment';
import { usePayments } from '@entities/payment';
import { useRefundsByPayment } from '@entities/refund';
import { useSettings } from '@entities/settings';
import { useStaffStore } from '@entities/staff/model/store';
import { tabKeys, useTab, useTabs } from '@entities/tab/model/queries';
import type { Tab } from '@entities/tab/model/types';
import type { PaymentMethod } from '@shared/lib/domain';
import { cn } from '@shared/lib/utils';
import { POSButton } from '@shared/ui';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { SearchInput } from '@shared/ui/SearchInput';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { EditReopenedItemsPanel } from './EditReopenedItemsPanel';
import { TabPaymentList } from './TabPaymentList';

interface RefundButtonProps {
  payment: Payment;
  onRefund: (paymentId: string) => void;
}

function RefundButton({ payment, onRefund }: RefundButtonProps) {
  const { t } = useTranslation('wPanels');
  const { data: refunds } = useRefundsByPayment(payment.id);
  const refundedTotal = (refunds ?? []).reduce((sum, r) => sum + r.amount, 0);
  const isFullyRefunded = refundedTotal >= payment.amount;

  if (payment.isRefund === true || payment.status === 'reopened_void' || isFullyRefunded)
    return null;

  return (
    <POSButton
      variant="destructive"
      size="sm"
      onClick={() => {
        onRefund(payment.id);
      }}
    >
      {t('paymentPane.refund')}
    </POSButton>
  );
}

interface EditTicketButtonProps {
  payment: Payment;
  onEdit: (tabId: string) => void;
}

function EditTicketButton({ payment, onEdit }: EditTicketButtonProps) {
  const { t } = useTranslation('wPanels');

  if (payment.isRefund === true || payment.status === 'reopened_void') return null;

  return (
    <POSButton
      variant="outline"
      size="sm"
      onClick={() => {
        onEdit(payment.tabId);
      }}
    >
      {t('paymentPane.editTicket')}
    </POSButton>
  );
}

interface ReopenTabButtonProps {
  payment: Payment;
  onReopen: (tabId: string) => void;
}

function ReopenTabButton({ payment, onReopen }: ReopenTabButtonProps) {
  const { t } = useTranslation('wPanels');

  if (payment.isRefund === true) return null;
  if (payment.status === 'reopened_void') return null;

  return (
    <POSButton
      variant="outline"
      size="sm"
      onClick={() => {
        onReopen(payment.tabId);
      }}
    >
      {t('paymentPane.reopenTab')}
    </POSButton>
  );
}

interface EditItemsButtonProps {
  payment: Payment;
  onEditItems: (tabId: string) => void;
}

/**
 * Visibility differs from its siblings (Pattern 3, RESEARCH.md Pitfall 3):
 * needs the tab's LIVE status (only a reopened, status='open' tab), not a
 * payment-status heuristic like payment.status === 'reopened_void' — that
 * heuristic is fragile across multiple reopens and doesn't reflect "is the
 * tab open right now."
 */
function EditItemsButton({ payment, onEditItems }: EditItemsButtonProps) {
  const { t } = useTranslation('wPanels');
  const { data: tab } = useTab(payment.tabId);

  if (payment.isRefund === true) return null;
  if (tab?.status !== 'open') return null;

  return (
    <POSButton
      variant="outline"
      size="sm"
      onClick={() => {
        onEditItems(payment.tabId);
      }}
    >
      {t('paymentPane.editItems')}
    </POSButton>
  );
}

type MethodFilter = 'all' | 'cash' | 'card' | 'bank_transfer' | 'refunds';

// wPanels namespace keys for each method's fallback label — used only when
// the store hasn't customized paymentLabels for that method.
const DEFAULT_PAYMENT_LABEL_KEY: Record<PaymentMethod, string> = {
  cash: 'paymentForm.defaultLabelCash',
  card: 'paymentForm.defaultLabelCard',
  bank_transfer: 'paymentForm.defaultLabelBankTransfer',
  rappi: 'paymentForm.defaultLabelRappi',
  uber_eats: 'paymentForm.defaultLabelUberEats',
};

function dayKey(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function PaymentHistoryList({
  onRefund,
  onEdit,
  onReopen,
  onEditItems,
}: {
  onRefund: (paymentId: string) => void;
  onEdit: (tabId: string) => void;
  onReopen: (tabId: string) => void;
  onEditItems: (tabId: string) => void;
}) {
  const { t, i18n } = useTranslation('wPanels');
  const { data: payments, isLoading } = usePayments();
  const { data: appSettings } = useSettings();
  const [searchParams] = useSearchParams();
  const idParam = searchParams.get('id');
  const [filterValue, setFilterValue] = useState(() => (idParam ?? '').trim());
  const [seededIdParam, setSeededIdParam] = useState(idParam);
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('all');

  // Re-seed the filter when ?id= changes on an already-mounted PaymentPane
  // (e.g. SPA navigation from AuditLogTable/EditHistoryTable without a full remount).
  // React-recommended "adjust state during render" pattern — avoids the extra
  // render + cascading-render lint violation an effect-based sync would cause.
  if (idParam && idParam !== seededIdParam) {
    setSeededIdParam(idParam);
    setFilterValue(idParam.trim());
  }

  const methodLabel = (method: Payment['method']): string =>
    appSettings?.paymentLabels[method] ?? t(DEFAULT_PAYMENT_LABEL_KEY[method]);
  const { time: timeFmt, day: dayFmt } = useMemo(
    () => ({
      time: new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }),
      day: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'full' }),
    }),
    [i18n.language]
  );
  const todayKey = dayKey(new Date());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayKey(yesterday);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t('paymentPane.loadingPayments')}</p>
      </div>
    );
  }

  if (!payments || payments.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-center text-muted-foreground">{t('paymentPane.noPaymentRecords')}</p>
      </div>
    );
  }

  const todays = payments.filter(p => dayKey(p.processedAt) === todayKey);
  const todaySales = todays.filter(p => !p.isRefund);
  const todayRefunds = todays.filter(p => p.isRefund);
  const sum = (list: Payment[]) => Math.round(list.reduce((s, p) => s + p.amount, 0) * 100) / 100;

  const visiblePayments = [...payments]
    .sort((a, b) => b.processedAt.getTime() - a.processedAt.getTime())
    .filter(p => {
      if (filterValue && !p.id.includes(filterValue.trim())) return false;
      if (methodFilter === 'refunds') return p.isRefund;
      if (methodFilter === 'all') return true;
      return !p.isRefund && p.method === methodFilter;
    });

  const groups = new Map<string, Payment[]>();
  for (const p of visiblePayments) {
    const key = dayKey(p.processedAt);
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const dayLabel = (key: string, sample: Date) =>
    key === todayKey
      ? t('paymentPane.dayToday')
      : key === yesterdayKey
        ? t('paymentPane.dayYesterday')
        : dayFmt.format(sample);

  const FILTERS: { key: MethodFilter; label: string }[] = [
    { key: 'all', label: t('paymentPane.filterAll') },
    { key: 'cash', label: t('paymentPane.filterCash') },
    { key: 'card', label: t('paymentPane.filterCard') },
    { key: 'bank_transfer', label: t('paymentPane.filterTransfer') },
    { key: 'refunds', label: t('paymentPane.filterRefunds') },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="space-y-4 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            {t('paymentPane.recentPayments')}
          </h2>
          <div className="flex gap-3">
            <div className="rounded-xl border border-border bg-card px-4 py-2 shadow-xs">
              <p className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                {t('paymentPane.todayTile')}
              </p>
              <div className="flex items-baseline gap-2">
                <MoneyDisplay amount={sum(todaySales)} size="lg" />
                <span className="text-xs text-muted-foreground">
                  {t('paymentPane.paymentsCount', { count: todaySales.length })}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card px-4 py-2 shadow-xs">
              <p className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                {t('paymentPane.refundsTodayTile')}
              </p>
              <div className="flex items-baseline gap-2">
                <MoneyDisplay
                  amount={Math.abs(sum(todayRefunds))}
                  negative={todayRefunds.length > 0}
                  size="lg"
                />
                <span className="text-xs text-muted-foreground">
                  {t('paymentPane.paymentsCount', { count: todayRefunds.length })}
                </span>
              </div>
            </div>
          </div>
        </div>
        {payments.length >= 100 && (
          <p className="text-xs text-muted-foreground">
            {t('paymentPane.tilesTruncatedHint', { count: payments.length })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            value={filterValue}
            onChange={setFilterValue}
            placeholder={t('paymentPane.filterByIdPlaceholder')}
            className="w-64"
          />
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={t('paymentPane.filterLabel')}
          >
            {FILTERS.map(f => (
              <Button
                key={f.key}
                type="button"
                size="sm"
                variant={methodFilter === f.key ? 'default' : 'outline'}
                aria-pressed={methodFilter === f.key}
                onClick={() => {
                  setMethodFilter(f.key);
                }}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
      {visiblePayments.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-center text-muted-foreground">{t('paymentPane.noPaymentRecords')}</p>
        </div>
      ) : (
        [...groups.entries()].map(([key, list]) => (
          <section key={key} aria-label={dayLabel(key, list[0]?.processedAt ?? new Date())}>
            <h3 className="sticky top-0 z-10 border-b border-border bg-background/90 px-5 py-1.5 text-xs font-semibold text-muted-foreground backdrop-blur-sm">
              {dayLabel(key, list[0]?.processedAt ?? new Date())}
            </h3>
            <div className="divide-y divide-border">
              {list.map(payment => (
                <div
                  key={payment.id}
                  data-testid={`payment-row-${payment.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-muted/40"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <MoneyDisplay
                      amount={Math.abs(payment.amount)}
                      negative={payment.isRefund === true}
                      size="md"
                      className="w-24 shrink-0"
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex items-center gap-1.5">
                        {payment.isRefund && (
                          <Badge variant="destructive">{t('paymentPane.refundBadge')}</Badge>
                        )}
                        <Badge variant="muted">{methodLabel(payment.method)}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {timeFmt.format(payment.processedAt)}
                        </span>
                      </div>
                      <span
                        className="font-mono text-[0.6875rem] text-muted-foreground/80"
                        title={payment.id}
                      >
                        {payment.id.slice(0, 8)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ReprintButton payment={payment} />
                    <EditTicketButton payment={payment} onEdit={onEdit} />
                    <ReopenTabButton payment={payment} onReopen={onReopen} />
                    <EditItemsButton payment={payment} onEditItems={onEditItems} />
                    <RefundButton payment={payment} onRefund={onRefund} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

export function PaymentPane() {
  const { t } = useTranslation('wPanels');
  const currentStaff = useStaffStore(s => s.currentStaff);
  const queryClient = useQueryClient();
  const { data: tabs } = useTabs();
  const openCount = (tabs ?? []).filter(tab => tab.status === 'open').length;

  const [selectedTab, setSelectedTab] = useState<Tab | null>(null);
  const [pinVerified, setPinVerified] = useState(false);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [refundTarget, setRefundTarget] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [reopenTarget, setReopenTarget] = useState<string | null>(null);
  const [editItemsTarget, setEditItemsTarget] = useState<string | null>(null);

  function handleSelectTab(tab: Tab) {
    setSelectedTab(tab);
    setPinVerified(false);
  }

  function handleClearSelection() {
    setSelectedTab(null);
    setPinVerified(false);
  }

  /**
   * Called immediately when payment succeeds — invalidates the tabs query so the
   * left-panel list refreshes, but does NOT clear the selected tab yet (receipt is
   * still visible). Selection is cleared by handlePaymentClose after receipt is dismissed.
   */
  function handlePaymentSuccess() {
    void queryClient.invalidateQueries({ queryKey: tabKeys.all });
  }

  /** Called when the user clicks Done on the receipt — clears the selected tab. */
  function handlePaymentClose() {
    setSelectedTab(null);
    setPinVerified(false);
  }

  return (
    <div className="flex size-full overflow-hidden">
      {/* Left panel — tab list */}
      <div
        className={cn(
          'flex shrink-0 flex-col border-r border-border bg-muted/30',
          openCount > 0 ? 'w-72' : 'w-56'
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            {t('paymentPane.tabsAwaitingPayment')}
          </h2>
          {openCount > 0 && (
            <Badge variant="brand" className="tabular-nums">
              {t('paymentPane.awaitingCount', { count: openCount })}
            </Badge>
          )}
        </div>
        <TabPaymentList selectedTabId={selectedTab?.id} onSelect={handleSelectTab} />
      </div>

      {/* Right panel — payment area or payment history */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {selectedTab == null ? (
          <PaymentHistoryList
            onRefund={setRefundTarget}
            onEdit={setEditTarget}
            onReopen={setReopenTarget}
            onEditItems={setEditItemsTarget}
          />
        ) : (
          <>
            {/* Right panel header */}
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <POSButton
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-full"
                onClick={handleClearSelection}
                aria-label={t('paymentPane.backToTabListAriaLabel')}
              >
                <ArrowLeft className="size-4" />
              </POSButton>
              <h2 className="text-base font-semibold tracking-tight">{selectedTab.customerName}</h2>
            </div>

            {!pinVerified ? (
              /* PIN verification prompt */
              <div className="flex flex-1 items-center justify-center p-8">
                <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center shadow-xs">
                  <div className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand-strong">
                    <ShieldCheck className="size-6" aria-hidden="true" />
                  </div>
                  <p className="text-sm text-muted-foreground">{t('paymentPane.pinRequired')}</p>
                  <POSButton
                    type="button"
                    touchSize="large"
                    onClick={() => {
                      setShowPinDialog(true);
                    }}
                  >
                    {t('paymentPane.verifyPinToProcessPayment')}
                  </POSButton>
                </div>
              </div>
            ) : (
              /* Payment form */
              <div className="flex flex-1 flex-col overflow-hidden">
                <PaymentForm
                  tab={selectedTab}
                  staffId={currentStaff?.id ?? ''}
                  onPaymentSuccess={handlePaymentSuccess}
                  onClose={handlePaymentClose}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* PIN gate dialog */}
      <ManagerPinDialog
        open={showPinDialog}
        onOpenChange={open => {
          setShowPinDialog(open);
        }}
        requiredAction="close_tab"
        onSuccess={() => {
          setPinVerified(true);
          setShowPinDialog(false);
        }}
      />

      {/* Refund sheet — opened from payment history rows */}
      <RefundSheet
        open={refundTarget !== null}
        paymentId={refundTarget}
        onOpenChange={open => {
          if (!open) setRefundTarget(null);
        }}
      />

      {/* Edit paid ticket dialog — opened from payment history rows */}
      <EditPaidTabDialog
        open={editTarget !== null}
        tabId={editTarget}
        onOpenChange={open => {
          if (!open) setEditTarget(null);
        }}
      />

      {/* Reopen tab dialog — opened from payment history rows */}
      <ReopenTabDialog
        open={reopenTarget !== null}
        tabId={reopenTarget}
        onOpenChange={open => {
          if (!open) setReopenTarget(null);
        }}
      />

      {/* Edit reopened items panel — opened from payment history rows once the tab is reopened */}
      <EditReopenedItemsPanel
        open={editItemsTarget !== null}
        tabId={editItemsTarget}
        onOpenChange={open => {
          if (!open) setEditItemsTarget(null);
        }}
      />
    </div>
  );
}
