import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Product } from '@shared/lib/domain';
import type { ProductRiskFlag } from './productRiskFlag';

/**
 * Shared confirm-toast gate for a flagged product (zero-price or low-stock,
 * Phase 12 D-04/D-05). Lives in `entities/product/model/` so multiple widgets
 * (`ProductGrid`, `ProductPeekWindow`) can import the same guard rather than
 * each reimplementing it.
 */
export function useConfirmRiskyAdd() {
  const { t } = useTranslation('entities');

  return (flag: NonNullable<ProductRiskFlag>, product: Product, onConfirm: () => void): void => {
    const toastFn = flag === 'zero-price' ? toast.error : toast.warning;
    const title =
      flag === 'zero-price'
        ? t('productRiskConfirm.zeroPriceTitle', { name: product.name })
        : t('productRiskConfirm.lowStockTitle', {
            name: product.name,
            count: product.quantityOnHand ?? 0,
          });
    const body =
      flag === 'zero-price'
        ? t('productRiskConfirm.zeroPriceBody')
        : t('productRiskConfirm.lowStockBody');

    toastFn(title, {
      description: body,
      duration: Infinity,
      action: {
        label: t('productRiskConfirm.confirm'),
        onClick: onConfirm,
        // sonner's default [data-button] height is 24px — under this
        // project's 44px touch-target minimum (UI-SPEC Spacing Scale
        // exception).
        // eslint-disable-next-line i18next/no-literal-string -- CSS value, not UI copy
        actionButtonStyle: { minHeight: '44px' },
      },
      cancel: {
        label: t('productRiskConfirm.cancel'),
        onClick: () => undefined,
        // eslint-disable-next-line i18next/no-literal-string -- CSS value, not UI copy
        actionButtonStyle: { minHeight: '44px' },
      },
    });
  };
}
