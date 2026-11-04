import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHoldSale } from '@features/hold-sale/model/useHoldSale';
import { useCartStore } from '@entities/tab/model/cartStore';
import { ConfirmDialog, POSButton } from '@shared/ui';
import { Badge } from '@shared/ui/badge';

export function HoldSaleBanner() {
  const { t } = useTranslation('wPanels');
  const { isHeld, resumeHeld, discardHeld } = useHoldSale();
  const [discardOpen, setDiscardOpen] = useState(false);
  // The cart store refuses to resume over a re-ring (it would bury the link to the old sale),
  // silently; the button says so instead.
  const reRingInCart = useCartStore(state => state.reRing !== null);

  if (!isHeld) return null;

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning-soft px-4 py-2.5">
      <Badge variant="warning">{t('holdSale.badge')}</Badge>
      {reRingInCart && (
        <p id="resume-blocked-reason" className="text-xs font-medium text-warning-strong">
          {t('holdSale.resumeBlocked')}
        </p>
      )}
      <div className="flex gap-2">
        <POSButton
          type="button"
          variant="outline"
          size="sm"
          disabled={reRingInCart}
          aria-describedby={reRingInCart ? 'resume-blocked-reason' : undefined}
          onClick={resumeHeld}
        >
          {t('holdSale.resume')}
        </POSButton>
        <POSButton
          type="button"
          variant="ghost"
          size="sm"
          className="text-warning-strong hover:bg-warning/20"
          onClick={() => {
            setDiscardOpen(true);
          }}
        >
          {t('holdSale.discard')}
        </POSButton>
      </div>
      <ConfirmDialog
        open={discardOpen}
        title={t('holdSale.discardTitle')}
        description={t('holdSale.discardBody')}
        confirmLabel={t('holdSale.discardConfirm')}
        onCancel={() => {
          setDiscardOpen(false);
        }}
        onConfirm={() => {
          discardHeld();
          setDiscardOpen(false);
        }}
      />
    </div>
  );
}
