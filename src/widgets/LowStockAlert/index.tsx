import { AlertTriangle, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inventoryStore, useInventory } from '@entities/inventory';
import { useStaffStore } from '@entities/staff/model/store';
import { cn } from '@shared/lib/utils';
import { POSButton } from '@shared/ui/POSButton';

const STORAGE_KEY = 'bola8pos:lowStockDismissed';

function readDismissedIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function writeDismissedIds(ids: Set<string>) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
}

export function LowStockAlert() {
  const { t } = useTranslation('wPanels');
  useInventory();
  const role = useStaffStore(s => s.currentStaff?.role);
  const lowStockAlerts = inventoryStore(s => s.lowStockAlerts);

  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissedIds());

  const dismiss = useCallback((productId: string) => {
    setDismissed(prev => {
      const next = new Set(prev);
      next.add(productId);
      writeDismissedIds(next);
      return next;
    });
  }, []);

  const visible = useMemo(
    () => lowStockAlerts.filter(a => !dismissed.has(a.productId)),
    [lowStockAlerts, dismissed]
  );

  if (role !== 'manager' && role !== 'admin') {
    return null;
  }

  if (visible.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-amber-950 '
      )}
      role="status"
      aria-label={t('lowStockAlert.lowStockAlertAriaLabel')}
      aria-live="polite"
    >
      <AlertTriangle className="size-4 shrink-0 text-warning-strong" aria-hidden />
      <span className="shrink-0 font-medium">{t('lowStockAlert.lowStockLabel')}</span>
      <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {visible.map((a, i) => (
          <li key={a.productId} className="inline-flex items-center gap-0.5">
            {i > 0 ? <span className="text-muted-foreground">,</span> : null}
            <span className="whitespace-nowrap">
              {t('lowStockAlert.nameQuantity', { name: a.name, quantity: a.quantityOnHand })}
            </span>
            <POSButton
              type="button"
              variant="ghost"
              touchSize="default"
              size="icon"
              className="text-warning-strong hover:bg-warning/20"
              aria-label={t('lowStockAlert.dismissAlertAriaLabel', { name: a.name })}
              onClick={() => {
                dismiss(a.productId);
              }}
            >
              <X className="size-3" />
            </POSButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
