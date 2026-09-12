import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { RegisterCajaEntryDialog } from '@features/register-caja-entry';
import {
  useCajaStore,
  useCurrentCaja,
  useMutationOpenCaja,
  useMutationCloseCaja,
  useCajaPaymentSummary,
  useCajaEntries,
  useMutationDeleteCajaEntry,
} from '@entities/caja';
import { useReceiptSettings, useSettings } from '@entities/settings';
import { usePermissions } from '@entities/staff';
import { useStaffStore } from '@entities/staff/model/store';
import { useOpenTabsPendingTotal } from '@entities/tab';

import { PAYMENT_METHODS, type PaymentMethod } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { printJobErrorCopyKey, printRawText } from '@shared/lib/pos-printer';
import { LoadingSpinner, MoneyDisplay } from '@shared/ui';
import { MoneyInput } from '@shared/ui/MoneyInput';
import { POSButton } from '@shared/ui/POSButton';
import { SectionHeader } from '@shared/ui/SectionHeader';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@shared/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@shared/ui/tooltip';

// wPanels namespace keys for each method's fallback label — mirrors
// PaymentPane's DEFAULT_PAYMENT_LABEL_KEY (paymentForm.* keys are shared
// across every payment-method-label surface, not just the payment form).
const DEFAULT_PAYMENT_LABEL_KEY: Record<PaymentMethod, string> = {
  cash: 'paymentForm.defaultLabelCash',
  card: 'paymentForm.defaultLabelCard',
  bank_transfer: 'paymentForm.defaultLabelBankTransfer',
  rappi: 'paymentForm.defaultLabelRappi',
  uber_eats: 'paymentForm.defaultLabelUberEats',
};

function formatDateTime(d: Date) {
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

type SummaryCardProps = {
  label: string;
  amount: number;
  isLoading: boolean;
  highlight?: string | undefined;
};

function SummaryCard({ label, amount, isLoading, highlight }: SummaryCardProps) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-xl border border-border bg-card p-4 shadow-xs ${highlight ?? ''}`}
    >
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      {isLoading ? (
        <LoadingSpinner size={16} className="p-0 justify-start" />
      ) : (
        <MoneyDisplay amount={amount} size="lg" />
      )}
    </div>
  );
}

export function CajaDashboard() {
  const { t } = useTranslation('wPanels');
  const { can } = usePermissions();
  const currentStaff = useStaffStore(s => s.currentStaff);
  const receiptSettings = useReceiptSettings();
  const { data: appSettings } = useSettings();
  const isCajaOpen = useCajaStore(s => s.isCajaOpen);
  const currentCaja = useCajaStore(s => s.currentCaja);

  // Sync store — CajaListener already does this globally, but hook is idempotent
  useCurrentCaja();

  const openCajaMut = useMutationOpenCaja();
  const closeCajaMut = useMutationCloseCaja();

  // Payment summary
  const summaryQuery = useCajaPaymentSummary(
    isCajaOpen && currentCaja ? { id: currentCaja.id, openedAt: currentCaja.openedAt } : null
  );
  const pendingQuery = useOpenTabsPendingTotal(isCajaOpen && currentCaja ? currentCaja.id : null);

  const summaryData = summaryQuery.data?.ok ? summaryQuery.data.data : null;
  const pendingTotal = pendingQuery.data?.ok ? pendingQuery.data.data : 0;
  const isSummaryLoading = summaryQuery.isLoading;
  const isPendingLoading = pendingQuery.isLoading;

  const isMethodEnabled = (method: PaymentMethod): boolean =>
    appSettings?.billing.paymentMethods[method] ?? true;
  const methodAmount = (method: PaymentMethod): number => summaryData?.[method] ?? 0;
  const methodLabel = (method: PaymentMethod): string =>
    appSettings?.paymentLabels[method] ?? t(DEFAULT_PAYMENT_LABEL_KEY[method]);
  // A method is shown when enabled OR it collected money this session even
  // if since disabled (an admin can toggle methods off mid-day; historical
  // collections must not silently disappear from the summary).
  const visibleMethods = PAYMENT_METHODS.filter(
    m => isMethodEnabled(m) || methodAmount(m) > 0
  );

  // Caja entries
  const entriesResult = useCajaEntries(currentCaja?.id ?? null);
  const deleteCajaEntryMut = useMutationDeleteCajaEntry();
  const entries = entriesResult.data?.ok ? entriesResult.data.data : [];
  const totalExpenses = entries
    .filter(e => e.type === 'expense')
    .reduce((sum, e) => sum + e.amount, 0);
  const totalIncome = entries
    .filter(e => e.type === 'income')
    .reduce((sum, e) => sum + e.amount, 0);

  const net =
    PAYMENT_METHODS.reduce((sum, m) => sum + methodAmount(m), 0) + totalIncome - totalExpenses;

  // Entry dialog state
  const [entryDialogOpen, setEntryDialogOpen] = useState(false);

  // Open caja dialog state
  const [openDialogVisible, setOpenDialogVisible] = useState(false);
  const [openingCash, setOpeningCash] = useState(0);

  // Close caja dialog state
  const [closeDialogVisible, setCloseDialogVisible] = useState(false);
  const [closingCash, setClosingCash] = useState(0);
  const [closeNotes, setCloseNotes] = useState('');

  const [isPrinting, setIsPrinting] = useState(false);

  function handleOpenCaja() {
    if (!currentStaff) return;
    openCajaMut.mutate(
      { openingCash, openedBy: currentStaff.id },
      {
        onSuccess: result => {
          if (result.ok) {
            toast.success(t('cajaDashboard.cajaOpenedSuccess'));
            setOpenDialogVisible(false);
            setOpeningCash(0);
          } else {
            toast.error(result.error.message);
          }
        },
      }
    );
  }

  function handleCloseCaja() {
    if (!currentCaja || !currentStaff) return;
    closeCajaMut.mutate(
      {
        cajaId: currentCaja.id,
        closedBy: currentStaff.id,
        closingCash,
        notes: closeNotes || undefined,
      },
      {
        onSuccess: result => {
          if (result.ok) {
            toast.success(t('cajaDashboard.cajaClosedSuccess'));
            setCloseDialogVisible(false);
            setClosingCash(0);
            setCloseNotes('');
          } else {
            const msg =
              result.error.code === 'OPEN_TABS_EXIST'
                ? t('cajaDashboard.openTabsExist')
                : result.error.message;
            toast.error(msg);
          }
        },
      }
    );
  }

  async function handlePrintSummary() {
    if (!currentCaja) return;
    setIsPrinting(true);

    const openedAt = formatDateTime(currentCaja.openedAt);
    const lines = [
      t('cajaDashboard.printDivider'),
      t('cajaDashboard.printTitle'),
      t('cajaDashboard.printDivider'),
      t('cajaDashboard.printOpened', { openedAt }),
      currentCaja.openedByName
        ? t('cajaDashboard.printBy', { name: currentCaja.openedByName })
        : '',
      t('cajaDashboard.printThinDivider'),
      ...visibleMethods.map(m =>
        t('cajaDashboard.printMethod', {
          label: methodLabel(m),
          amount: formatMoney(methodAmount(m)),
        })
      ),
      t('cajaDashboard.printThinDivider'),
      t('cajaDashboard.printNetTotal', { amount: formatMoney(net) }),
      t('cajaDashboard.printOpenTabs', { amount: formatMoney(pendingTotal) }),
      t('cajaDashboard.printDivider'),
    ]
      .filter(l => l !== '')
      .join('\n');

    const result = await printRawText(lines, {
      autoCut: receiptSettings.data?.autoCut,
      printerName: receiptSettings.data?.printerName,
    });
    setIsPrinting(false);

    // No toast on success — a successful durable acceptance stays silent
    // (status badge only, wired in a later plan); see UI-SPEC's
    // no-success-toast rule (PRN-04/UX).
    if (!result.ok) {
      toast.error(t(printJobErrorCopyKey(result.error.code)));
    }
  }

  if (!can('manage_caja')) return null;

  return (
    <section className="space-y-5 rounded-2xl border border-border bg-card p-5 shadow-xs">
      <SectionHeader
        title={t('cajaDashboard.title')}
        description={t('cajaDashboard.description')}
      />

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('cajaDashboard.statusLabel')}</span>
          <Badge variant={isCajaOpen ? 'default' : 'secondary'}>
            {isCajaOpen ? t('cajaDashboard.open') : t('cajaDashboard.closed')}
          </Badge>
        </div>

        {currentCaja && (
          <>
            <div className="text-sm text-muted-foreground">
              {t('cajaDashboard.openedLabel')}{' '}
              <span className="text-foreground">{formatDateTime(currentCaja.openedAt)}</span>
            </div>
            {currentCaja.openedByName && (
              <div className="text-sm text-muted-foreground">
                {t('cajaDashboard.byLabel')}{' '}
                <span className="text-foreground">{currentCaja.openedByName}</span>
              </div>
            )}
            <div className="text-sm text-muted-foreground">
              {t('cajaDashboard.openingCashLabel')}{' '}
              <span className="text-foreground font-mono">
                {formatMoney(currentCaja.openingCash)}
              </span>
            </div>
          </>
        )}
      </div>

      {/* 5-card cash intelligence summary */}
      {isCajaOpen && currentCaja !== null && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {visibleMethods.map(m => (
              <SummaryCard
                key={m}
                label={methodLabel(m)}
                amount={methodAmount(m)}
                isLoading={isSummaryLoading}
              />
            ))}
            <SummaryCard
              label={t('cajaDashboard.pendingOpenTabs')}
              amount={pendingTotal}
              isLoading={isPendingLoading}
              highlight="border-warning/40"
            />
            <SummaryCard
              label={t('cajaDashboard.net')}
              amount={net}
              isLoading={isSummaryLoading}
              highlight="border-brand/40"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {can('manage_caja') && (
              <POSButton
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  setEntryDialogOpen(true);
                }}
              >
                {t('cajaDashboard.registerExpenseIncome')}
              </POSButton>
            )}
            <Link
              to="/payments"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              {t('cajaDashboard.viewTabs')}
            </Link>
          </div>

          {/* Entries list */}
          {can('manage_caja') && entries.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">
                {t('cajaDashboard.recentEntries')}
              </h4>
              <div className="space-y-1">
                {entries.slice(-10).map(entry => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2.5 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={entry.type === 'expense' ? 'destructive' : 'default'}
                        className="capitalize"
                      >
                        {entry.type}
                      </Badge>
                      <span className="text-muted-foreground truncate max-w-[200px]">
                        {entry.concept}
                      </span>
                      {entry.staffName && (
                        <span className="text-xs text-muted-foreground">— {entry.staffName}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={
                          entry.type === 'expense'
                            ? 'text-destructive font-mono'
                            : 'text-success-strong font-mono'
                        }
                      >
                        {formatMoney(entry.type === 'expense' ? -entry.amount : entry.amount, {
                          showSign: true,
                        })}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="size-6 p-0 text-muted-foreground hover:text-destructive"
                        disabled={deleteCajaEntryMut.isPending}
                        onClick={() => {
                          deleteCajaEntryMut.mutate(entry.id, {
                            onSuccess: result => {
                              if (result.ok) {
                                toast.success(t('cajaDashboard.entryDeleted'));
                              } else {
                                toast.error(result.error.message);
                              }
                            },
                          });
                        }}
                        aria-label={`Delete entry: ${entry.concept}`}
                      >
                        ×
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {totalExpenses > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('cajaDashboard.totalExpensesLabel')}{' '}
                  <span className="font-medium text-destructive">{formatMoney(totalExpenses)}</span>
                  {totalIncome > 0 && (
                    <>
                      {' '}
                      {t('cajaDashboard.totalIncomeLabel')}{' '}
                      <span className="font-medium text-success-strong">
                        {formatMoney(totalIncome)}
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Print Summary — always visible; disabled with tooltip when no open caja */}
      <div className="flex flex-wrap items-center gap-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <POSButton
                  size="sm"
                  type="button"
                  disabled={!isCajaOpen || !currentCaja || isPrinting}
                  onClick={() => {
                    void handlePrintSummary();
                  }}
                >
                  {isPrinting ? t('cajaDashboard.printing') : t('cajaDashboard.printSummary')}
                </POSButton>
              </span>
            </TooltipTrigger>
            {(!isCajaOpen || !currentCaja) && (
              <TooltipContent>{t('cajaDashboard.openCajaSessionFirst')}</TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Register Entry Dialog */}
      <RegisterCajaEntryDialog open={entryDialogOpen} onOpenChange={setEntryDialogOpen} />

      <div className="flex flex-wrap gap-2">
        {!isCajaOpen && (
          <POSButton
            type="button"
            size="sm"
            onClick={() => {
              setOpenDialogVisible(true);
            }}
          >
            {t('cajaDashboard.openCaja')}
          </POSButton>
        )}
        {isCajaOpen && currentCaja && (
          <POSButton
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => {
              setCloseDialogVisible(true);
            }}
          >
            {t('cajaDashboard.closeCaja')}
          </POSButton>
        )}
      </div>

      {/* Open Caja Dialog */}
      <Dialog open={openDialogVisible} onOpenChange={setOpenDialogVisible}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('cajaDashboard.openCaja')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <MoneyInput
              label={t('cajaDashboard.openingCash')}
              value={openingCash}
              onChange={setOpeningCash}
              placeholder="0.00"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpenDialogVisible(false);
              }}
            >
              {t('cajaDashboard.cancel')}
            </Button>
            <POSButton type="button" disabled={openCajaMut.isPending} onClick={handleOpenCaja}>
              {openCajaMut.isPending ? t('cajaDashboard.opening') : t('cajaDashboard.openCaja')}
            </POSButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close Caja Dialog */}
      <Dialog open={closeDialogVisible} onOpenChange={setCloseDialogVisible}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('cajaDashboard.closeCaja')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <MoneyInput
              label={t('cajaDashboard.closingCashCount')}
              value={closingCash}
              onChange={setClosingCash}
              placeholder="0.00"
            />
            <div className="space-y-1">
              <label htmlFor="close-notes" className="text-sm font-medium">
                {t('cajaDashboard.notesOptional')}
              </label>
              <textarea
                id="close-notes"
                value={closeNotes}
                onChange={e => {
                  setCloseNotes(e.target.value);
                }}
                placeholder={t('cajaDashboard.endOfDayNotesPlaceholder')}
                rows={3}
                className="w-full rounded-lg border border-input bg-card px-3.5 py-2.5 text-sm shadow-xs placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none dark:bg-input/20"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCloseDialogVisible(false);
              }}
            >
              {t('cajaDashboard.cancel')}
            </Button>
            <POSButton
              type="button"
              variant="destructive"
              disabled={closeCajaMut.isPending}
              onClick={handleCloseCaja}
            >
              {closeCajaMut.isPending ? t('cajaDashboard.closing') : t('cajaDashboard.closeCaja')}
            </POSButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
