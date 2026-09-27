import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { LogoUploader } from '@features/upload-logo';
import { cajaKeys } from '@entities/caja';
import { useAvailablePrinters } from '@entities/print-job';
import { useReceiptSettings, useMutationUpdateReceiptSettings } from '@entities/settings';
import type { ReceiptSettings } from '@entities/settings';
import type { UserRole } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { getCurrentLocale } from '@shared/lib/i18n';
import { openCashDrawer, printJobErrorCopyKey, testPrint } from '@shared/lib/pos-printer';
import { buildThermalReceiptText } from '@shared/lib/receipt-format';
import { getTerminalId, setTerminalId } from '@shared/lib/terminal';
import { POSButton, ProtectedAction } from '@shared/ui';
import { Checkbox } from '@shared/ui/checkbox';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Textarea } from '@shared/ui/textarea';
import { useRegisterUnsavedChanges } from '../model/unsaved-changes';

type Props = {
  currentRole: UserRole | null;
};

const PAPER_OPTIONS = [
  { value: 32, label: '58mm (32 chars)' },
  { value: 40, label: '80mm standard (40 chars)' },
  { value: 48, label: '80mm wide (48 chars)' },
] as const;

// Fixed/deterministic sample data for the Settings live preview — never sent
// anywhere, only fed through the same buildThermalReceiptText() used for
// real print/email receipts so the preview can't diverge from output.
const SAMPLE_RECEIPT_DATA: ReceiptData = {
  receiptNumber: 'PREVIEW01',
  tabId: '00000000-0000-4000-8000-000000000000',
  customerName: 'Cliente',
  cashierName: 'Ana',
  storeName: 'Tienda',
  barAddress: '',
  items: [
    { name: 'Arroz Basmati 1kg', quantity: 2, unitPrice: 45, lineTotal: 90 },
    {
      name: 'Aceite de Girasol 1L',
      quantity: 1,
      unitPrice: 38,
      lineTotal: 38,
      modifierNames: ['Sin bolsa'],
    },
  ],
  subtotal: 128,
  total: 128,
  paymentMethod: 'cash',
  processedAt: new Date('2026-01-01T12:00:00.000Z'),
  squareReceiptUrl: null,
  tenderedAmount: 150,
  changeAmount: 22,
};

export function HardwareSettingsTab({ currentRole }: Props) {
  const { t } = useTranslation('wAdmin');
  const { t: tSettings } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [printing, setPrinting] = useState(false);
  const [openingDrawer, setOpeningDrawer] = useState(false);
  const { data: receiptSettings } = useReceiptSettings();
  const updateReceiptSettings = useMutationUpdateReceiptSettings();
  const { data: printerList, isError: printerListErrored } = useAvailablePrinters();

  // Terminal ID — keys this station's caja + audit trail (src/shared/lib/terminal.ts).
  const [savedTerminalId, setSavedTerminalId] = useState(() => getTerminalId());
  const [terminalIdInput, setTerminalIdInput] = useState(savedTerminalId);
  const [terminalIdError, setTerminalIdError] = useState<string | null>(null);

  function saveTerminalId(): boolean {
    const result = setTerminalId(terminalIdInput);
    if (!result.ok) {
      setTerminalIdError(tSettings('hardware.terminal.invalid'));
      return false;
    }
    const persisted = getTerminalId();
    setTerminalIdError(null);
    setSavedTerminalId(persisted);
    setTerminalIdInput(persisted);
    void queryClient.invalidateQueries({ queryKey: cajaKeys.all });
    toast.success(tSettings('hardware.terminal.saved'));
    return true;
  }

  useRegisterUnsavedChanges(terminalIdInput !== savedTerminalId, () => Promise.resolve(saveTerminalId()));

  // Optimistic local state — mirrors server value, updated immediately on change.
  // Lazy initializer captures the first available server value; afterwards
  // patchReceipt drives all state changes (optimistic + rollback on error).
  const [localReceipt, setLocalReceipt] = useState<ReceiptSettings | undefined>(
    () => receiptSettings
  );

  const receipt = localReceipt ?? receiptSettings;

  function patchReceipt(patch: Partial<ReceiptSettings>) {
    if (!receipt) return;
    const next: ReceiptSettings = { ...receipt, ...patch };
    // Apply optimistically so controlled inputs reflect the new value immediately
    setLocalReceipt(next);
    updateReceiptSettings.mutate(next, {
      onSuccess: result => {
        if (!result.ok) {
          // Roll back optimistic update on failure
          setLocalReceipt(receipt);
          toast.error(result.error.message);
        }
      },
    });
  }

  // Draft-only update (no network call) — used by free-text fields so the
  // live preview reflects every keystroke without persisting on each one.
  // The actual save still happens via patchReceipt on blur.
  function applyLocal(patch: Partial<ReceiptSettings>) {
    if (!receipt) return;
    setLocalReceipt({ ...receipt, ...patch });
  }

  const runTestPrint = async () => {
    setPrinting(true);
    const result = await testPrint(receipt?.printerName);
    setPrinting(false);
    if (!result.ok) {
      toast.error(t(printJobErrorCopyKey(result.error.code)));
    }
    // No toast on success — a successful durable acceptance stays silent
    // (status badge only, wired in a later plan); see UI-SPEC's
    // no-success-toast rule (PRN-04/UX).
  };

  const runOpenDrawer = async () => {
    setOpeningDrawer(true);
    const result = await openCashDrawer(receipt?.printerName);
    setOpeningDrawer(false);
    if (!result.ok) {
      toast.error(t(printJobErrorCopyKey(result.error.code)));
    }
  };

  return (
    <ProtectedAction
      action="manage_settings"
      currentRole={currentRole}
      disabled={printing || openingDrawer}
    >
      <div className="space-y-6">
        <div className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
          <h3 className="font-medium">{tSettings('hardware.terminal.title')}</h3>
          <div className="space-y-1">
            <Label htmlFor="terminal-id">{tSettings('hardware.terminal.label')}</Label>
            <Input
              id="terminal-id"
              data-testid="terminal-id-input"
              maxLength={32}
              value={terminalIdInput}
              onChange={e => {
                setTerminalIdInput(e.target.value);
                setTerminalIdError(null);
              }}
            />
            <p className="text-sm text-muted-foreground">{tSettings('hardware.terminal.help')}</p>
            {terminalIdError && (
              <p role="alert" className="text-sm text-destructive">
                {terminalIdError}
              </p>
            )}
          </div>
          <POSButton
            type="button"
            touchSize="large"
            data-testid="terminal-id-save"
            disabled={terminalIdInput === savedTerminalId}
            onClick={saveTerminalId}
          >
            {tSettings('hardware.terminal.save')}
          </POSButton>
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-semibold">{t('hardwareSettingsTab.title')}</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <POSButton
              type="button"
              touchSize="large"
              disabled={printing || openingDrawer}
              onClick={() => {
                void runTestPrint();
              }}
            >
              {printing ? t('hardwareSettingsTab.printing') : t('hardwareSettingsTab.testPrint')}
            </POSButton>
            <POSButton
              type="button"
              touchSize="large"
              variant="outline"
              disabled={printing || openingDrawer}
              onClick={() => {
                void runOpenDrawer();
              }}
            >
              {openingDrawer
                ? t('hardwareSettingsTab.opening')
                : t('hardwareSettingsTab.openCashDrawer')}
            </POSButton>
          </div>
        </div>

        {receipt && <LogoUploader receipt={receipt} />}

        {receipt && (
          <div className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <h3 className="font-medium">{t('hardwareSettingsTab.receiptSettingsTitle')}</h3>

            <div className="space-y-1">
              <Label htmlFor="printer-name">{t('hardwareSettingsTab.printerLabel')}</Label>
              <select
                id="printer-name"
                value={receipt.printerName ?? ''}
                onChange={e => {
                  patchReceipt({ printerName: e.target.value.length > 0 ? e.target.value : null });
                }}
                className="h-11 w-full rounded-lg border border-input bg-card px-3 shadow-xs dark:bg-input/20 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
              >
                <option value="">{t('hardwareSettingsTab.printerNotConfiguredOption')}</option>
                {printerList?.printers.map(name => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {receipt.printerName &&
                  printerList?.printers.every(name => name !== receipt.printerName) && (
                    <option value={receipt.printerName}>{receipt.printerName}</option>
                  )}
              </select>
              {printerListErrored && (
                <p className="text-sm text-destructive">
                  {t('hardwareSettingsTab.printerListError')}
                </p>
              )}
              {!printerListErrored && printerList?.printers.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t('hardwareSettingsTab.printerListEmpty')}
                </p>
              )}
              {printerList?.default && (
                <p className="text-sm text-muted-foreground">
                  {t('hardwareSettingsTab.printerDetectedDefault', { name: printerList.default })}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="paper-width">{t('hardwareSettingsTab.paperWidthLabel')}</Label>
              <select
                id="paper-width"
                value={receipt.paperWidthChars}
                onChange={e => {
                  patchReceipt({ paperWidthChars: Number(e.target.value) as 32 | 40 | 48 });
                }}
                className="h-11 w-full rounded-lg border border-input bg-card px-3 shadow-xs dark:bg-input/20 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
              >
                {PAPER_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="receipt-headerLine2">
                {t('hardwareSettingsTab.headerLine2Label')}
              </Label>
              <Input
                id="receipt-headerLine2"
                value={receipt.headerLine2}
                maxLength={48}
                placeholder={t('hardwareSettingsTab.headerLine2Placeholder')}
                onChange={e => {
                  applyLocal({ headerLine2: e.target.value });
                }}
                onBlur={() => {
                  patchReceipt({ headerLine2: receipt.headerLine2 });
                }}
              />
              <p className="text-sm text-muted-foreground">
                {t('hardwareSettingsTab.charCount', { count: receipt.headerLine2.length, max: 48 })}
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="receipt-footerText">{t('hardwareSettingsTab.footerTextLabel')}</Label>
              <Textarea
                id="receipt-footerText"
                value={receipt.footerText}
                maxLength={480}
                placeholder={t('hardwareSettingsTab.footerTextPlaceholder')}
                onChange={e => {
                  applyLocal({ footerText: e.target.value });
                }}
                onBlur={() => {
                  patchReceipt({ footerText: receipt.footerText });
                }}
              />
              <p className="text-sm text-muted-foreground">
                {t('hardwareSettingsTab.charCount', { count: receipt.footerText.length, max: 480 })}
              </p>
            </div>

            <div className="space-y-3">
              {(
                [
                  {
                    key: 'showCashierName',
                    label: t('hardwareSettingsTab.showCashierName'),
                  },
                  {
                    key: 'showCustomerName',
                    label: t('hardwareSettingsTab.showCustomerName'),
                  },
                  {
                    key: 'showReceiptNumber',
                    label: t('hardwareSettingsTab.showReceiptNumber'),
                  },
                  { key: 'boldTotals', label: t('hardwareSettingsTab.boldTotals') },
                  { key: 'printOnStart', label: t('hardwareSettingsTab.printOnStart') },
                  { key: 'autoCut', label: t('hardwareSettingsTab.autoCut') },
                ] as const
              ).map(({ key, label }) => (
                <div key={key} className="flex items-center gap-3">
                  <Checkbox
                    id={`receipt-${key}`}
                    checked={receipt[key]}
                    onCheckedChange={c => {
                      patchReceipt({ [key]: c === true });
                    }}
                  />
                  <Label htmlFor={`receipt-${key}`}>{label}</Label>
                </div>
              ))}
            </div>

            <h4 className="text-sm font-medium">{t('hardwareSettingsTab.previewTitle')}</h4>
            <p className="text-sm text-muted-foreground">
              {t('hardwareSettingsTab.previewHelper')}
            </p>
            <pre
              data-testid="receipt-live-preview"
              className="max-h-[50vh] overflow-auto rounded-xl border border-border bg-muted/40 p-4 font-mono text-[11px] leading-tight whitespace-pre"
            >
              {buildThermalReceiptText(SAMPLE_RECEIPT_DATA, getCurrentLocale(), receipt)}
            </pre>
          </div>
        )}
      </div>
    </ProtectedAction>
  );
}
