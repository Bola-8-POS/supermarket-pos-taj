import { useTranslation } from 'react-i18next';
import { LoadingSpinner, POSButton } from '@shared/ui';
import { useOpenOpenUnit } from '../model/useOpenOpenUnit';

export interface OpenUnitButtonProps {
  productId: string;
  productName: string;
  disabled?: boolean;
}

// D-11: opening a new unit is bartender+ — the floor for every authenticated
// non-kitchen role — so this button carries no role gate of any kind
// (no ProtectedAction, no canAccess/usePermissions check). A gate here would
// be a permission that always passes while implying one that sometimes does
// not. Do not "fix" this by adding one.
export function OpenUnitButton({ productId, productName, disabled }: OpenUnitButtonProps) {
  const { t } = useTranslation('featMgmt');
  const { openUnit, isSaving } = useOpenOpenUnit();

  return (
    <POSButton
      type="button"
      touchSize="large"
      disabled={disabled || isSaving}
      onClick={() => {
        void openUnit({ productId, productName });
      }}
    >
      {isSaving ? <LoadingSpinner className="mr-2 size-4" /> : null}
      {isSaving ? t('common:actions.saving') : t('openOpenUnit.openNewUnit')}
    </POSButton>
  );
}
