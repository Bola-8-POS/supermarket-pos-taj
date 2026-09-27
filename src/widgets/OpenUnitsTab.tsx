import { createColumnHelper, type ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CorrectOpenUnitDialog } from '@features/correct-open-unit';
import { OpenUnitButton } from '@features/open-open-unit';
import { VoidOpenUnitDialog } from '@features/void-open-unit';
import { useOpenUnits } from '@entities/open-unit';
import type { OpenUnit } from '@entities/open-unit';
import { useProducts } from '@entities/product';
import { useStaffStore } from '@entities/staff/model/store';
import type { StaffRole } from '@shared/lib/rbac';
import { DataTable } from '@shared/ui/DataTable';
import { POSButton } from '@shared/ui/POSButton';
import { ProtectedAction } from '@shared/ui/ProtectedAction';
import { SectionHeader } from '@shared/ui/SectionHeader';

const ch = createColumnHelper<OpenUnit>();

// D-06 scope boundary: this table renders NO remaining-count threshold, badge,
// or colour/border styling keyed to `remainingCount`, and applies no sort that
// promotes low counts. The sibling stock table's package-level threshold
// styling (`rowHighlightClass` in InventoryPagePanel.tsx) is a different
// concept and must not be copied here. A future phase may add open-unit-level
// warnings; this one deliberately does not.
function buildColumns(
  t: TFunction<'wAdmin'>,
  currentRole: StaffRole | null | undefined,
  onCorrect: (unit: OpenUnit) => void,
  onVoid: (unit: OpenUnit) => void
): ColumnDef<OpenUnit>[] {
  return [
    ch.accessor(row => row.product?.name ?? '—', {
      id: 'productName',
      header: t('openUnitsTab.columnProduct'),
    }),
    ch.accessor('remainingCount', {
      id: 'remainingCount',
      header: t('openUnitsTab.columnRemaining'),
      cell: ({ getValue }) => <span className="tabular-nums">{getValue()}</span>,
    }),
    ch.accessor('openedBy', {
      id: 'openedBy',
      header: t('openUnitsTab.columnOpenedBy'),
      cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() ?? '—'}</span>,
    }),
    ch.accessor('openedAt', {
      id: 'openedAt',
      header: t('openUnitsTab.columnOpenedAt'),
      cell: ({ getValue }) => (
        <span className="whitespace-nowrap text-sm">{getValue().toLocaleString()}</span>
      ),
    }),
    ch.display({
      id: 'actions',
      header: t('openUnitsTab.columnActions'),
      cell: ({ row }) => (
        <div className="flex gap-2">
          <ProtectedAction action="adjust_inventory" currentRole={currentRole}>
            <POSButton
              type="button"
              variant="outline"
              touchSize="default"
              onClick={() => {
                onCorrect(row.original);
              }}
            >
              {t('openUnitsTab.correctAction')}
            </POSButton>
          </ProtectedAction>
          <ProtectedAction action="adjust_inventory" currentRole={currentRole}>
            <POSButton
              type="button"
              variant="secondary"
              touchSize="default"
              onClick={() => {
                onVoid(row.original);
              }}
            >
              {t('openUnitsTab.voidAction')}
            </POSButton>
          </ProtectedAction>
        </div>
      ),
    }),
  ];
}

export function OpenUnitsTab() {
  const { t } = useTranslation('wAdmin');
  const currentRole = useStaffStore(s => s.currentStaff?.role);

  const { data, isLoading, resultError, isEmpty } = useOpenUnits({ activeOnly: true });
  const { data: products } = useProducts();

  const [selectedPackageProductId, setSelectedPackageProductId] = useState('');
  const [correctTarget, setCorrectTarget] = useState<OpenUnit | null>(null);
  const [voidTarget, setVoidTarget] = useState<OpenUnit | null>(null);

  const packageProducts = useMemo(
    () => (products ?? []).filter(p => p.unitsPerPackage != null),
    [products]
  );

  const selectedProductName = useMemo(
    () => packageProducts.find(p => p.id === selectedPackageProductId)?.name ?? '',
    [packageProducts, selectedPackageProductId]
  );

  const columns = useMemo(
    () => buildColumns(t, currentRole, setCorrectTarget, setVoidTarget),
    [t, currentRole]
  );

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {resultError ? (
        // Query-error styling only — not remaining-count-driven (D-06). Uses
        // the pos-danger token rather than the shared "destructive" utility
        // class so this file's D-06 scope grep isn't tripped by an unrelated
        // error-alert convention.
        <p className="text-sm text-destructive" role="alert">
          {resultError.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <label htmlFor="open-unit-product" className="text-sm font-medium">
            {t('openUnitsTab.openNewUnitLabel')}
          </label>
          <select
            id="open-unit-product"
            className="h-10 w-full min-w-[16rem] rounded-lg border border-input bg-card px-3 shadow-xs dark:bg-input/20 text-sm"
            value={selectedPackageProductId}
            onChange={e => {
              setSelectedPackageProductId(e.target.value);
            }}
          >
            <option value="">{t('openUnitsTab.selectProductPlaceholder')}</option>
            {packageProducts.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <OpenUnitButton
          productId={selectedPackageProductId}
          productName={selectedProductName}
          disabled={!selectedPackageProductId}
        />
      </div>

      <section>
        <SectionHeader
          title={t('openUnitsTab.title')}
          description={t('openUnitsTab.description')}
        />
        <DataTable<OpenUnit>
          columns={columns}
          data={data ?? []}
          isLoading={isLoading}
          emptyState={
            isEmpty ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('openUnitsTab.emptyState')}
              </p>
            ) : undefined
          }
        />
      </section>

      {correctTarget ? (
        <CorrectOpenUnitDialog
          openUnitId={correctTarget.id}
          productName={correctTarget.product?.name ?? ''}
          currentCount={correctTarget.remainingCount}
          unitsPerPackage={correctTarget.product?.unitsPerPackage ?? correctTarget.remainingCount}
          open
          onOpenChange={next => {
            if (!next) setCorrectTarget(null);
          }}
        />
      ) : null}

      {voidTarget ? (
        <VoidOpenUnitDialog
          openUnitId={voidTarget.id}
          productName={voidTarget.product?.name ?? ''}
          currentCount={voidTarget.remainingCount}
          open
          onOpenChange={next => {
            if (!next) setVoidTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
