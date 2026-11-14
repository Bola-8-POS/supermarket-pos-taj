import { useTranslation } from 'react-i18next';
import type { CartItem, CheckoutDraft } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';

export interface RestoredValueReviewProps {
  items: ReadonlyArray<CartItem>;
  totalCents: number;
  draft: CheckoutDraft | null;
}

const cents = (value: number) => formatMoney(value / 100);

/**
 * D-02: read-only preview of the saved snapshot (cart lines, total, non-sensitive payment details).
 * Saved values only: no catalog read, no key, PIN, approval or marker field.
 */
export function RestoredValueReview({ items, totalCents, draft }: RestoredValueReviewProps) {
  const { t } = useTranslation('wPanels');
  const methodLabel = (method: CheckoutDraft['method']) => t(`resumeSale.methods.${method}`);

  return (
    <div className="space-y-4">
      <section aria-labelledby="resume-basket-heading" className="space-y-2">
        <h3 id="resume-basket-heading" className="text-sm font-semibold">
          {t('resumeSale.basketHeading')}
        </h3>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('resumeSale.colProduct')}</th>
                <th className="px-3 py-2 font-medium">{t('resumeSale.colQuantity')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('resumeSale.colUnitPrice')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('resumeSale.colLineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.tempId} data-testid="resume-line" className="border-t border-border">
                  <td className="px-3 py-2">{item.product.name}</td>
                  <td className="px-3 py-2" data-testid="resume-line-quantity">
                    {item.weightGrams != null
                      ? t('resumeSale.weight', { weight: (item.weightGrams / 1000).toFixed(3) })
                      : String(item.quantity)}
                  </td>
                  <td className="px-3 py-2 text-right" data-testid="resume-line-unit-price">
                    {formatMoney(item.unitPrice)}
                  </td>
                  <td className="px-3 py-2 text-right" data-testid="resume-line-total">
                    {formatMoney(item.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="flex justify-between text-sm font-semibold">
          <span>{t('resumeSale.total')}</span>
          <span data-testid="resume-total">{cents(totalCents)}</span>
        </p>
      </section>

      {draft && (
        <section aria-labelledby="resume-checkout-heading" className="space-y-1 text-sm">
          <h3 id="resume-checkout-heading" className="font-semibold">
            {t('resumeSale.checkoutHeading')}
          </h3>
          {draft.splitLegs.length >= 2 ? (
            <div>
              <p className="text-muted-foreground">{t('resumeSale.splitLegs')}</p>
              <ol className="space-y-0.5">
                {draft.splitLegs.map((leg, index) => (
                  // legs have no id and keep a fixed order
                  <li
                    key={`${leg.method}-${String(index)}`}
                    data-testid="resume-split-leg"
                    className="flex justify-between"
                  >
                    <span>{methodLabel(leg.method)}</span>
                    <span>{cents(leg.amountCents)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <>
              <p className="flex justify-between">
                <span className="text-muted-foreground">{t('resumeSale.method')}</span>
                <span data-testid="resume-method">{methodLabel(draft.method)}</span>
              </p>
              {draft.method === 'cash' && (
                <p className="flex justify-between">
                  <span className="text-muted-foreground">{t('resumeSale.tendered')}</span>
                  <span data-testid="resume-tendered">{cents(draft.tenderedCents)}</span>
                </p>
              )}
            </>
          )}
          {draft.discount && (
            <p className="flex justify-between">
              <span className="text-muted-foreground">{t('resumeSale.discountLabel')}</span>
              <span data-testid="resume-discount">
                {draft.discount.type === 'fixed'
                  ? cents(draft.discount.value)
                  : t('resumeSale.discountPercent', { value: draft.discount.value })}
              </span>
            </p>
          )}
          {draft.reference !== null && (
            <p className="flex justify-between">
              <span className="text-muted-foreground">{t('resumeSale.reference')}</span>
              <span data-testid="resume-reference">{draft.reference}</span>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
