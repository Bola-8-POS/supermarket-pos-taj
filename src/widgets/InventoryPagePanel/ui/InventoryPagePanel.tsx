import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OpenUnitsTab } from '@widgets/OpenUnitsTab';
import { useStaffStore } from '@entities/staff/model/store';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@shared/ui/tabs';
import { CatalogTab } from './CatalogTab';
import { MovementsTab } from './MovementsTab';
import { NearExpiryTab } from './NearExpiryTab';
import { StockTab } from './StockTab';

type InventoryTab = 'stock' | 'catalog' | 'open-units' | 'near-expiry' | 'movements';

export function InventoryPagePanel() {
  const { t } = useTranslation('wAdmin');
  const currentRole = useStaffStore(s => s.currentStaff?.role ?? null);
  const { can } = usePermissions();
  const canManageProducts = can('manage_products');
  const [tab, setTab] = useState<InventoryTab>('stock');

  return (
    <Tabs
      value={tab}
      onValueChange={next => {
        setTab(next as InventoryTab);
      }}
      className="w-full"
    >
      <TabsList className="mb-4 h-auto flex-wrap">
        <TabsTrigger value="stock">{t('inventoryPagePanel.stockTabLabel')}</TabsTrigger>
        {canManageProducts && (
          <TabsTrigger value="catalog">{t('inventoryPagePanel.catalogTabLabel')}</TabsTrigger>
        )}
        <TabsTrigger value="open-units">{t('inventoryPagePanel.openUnitsTabLabel')}</TabsTrigger>
        <TabsTrigger value="near-expiry">{t('inventoryPagePanel.nearExpiryTabLabel')}</TabsTrigger>
        <TabsTrigger value="movements">{t('inventoryPagePanel.movementsTabLabel')}</TabsTrigger>
      </TabsList>
      <TabsContent value="stock">
        <StockTab
          onOpenCatalog={
            canManageProducts
              ? () => {
                  setTab('catalog');
                }
              : undefined
          }
        />
      </TabsContent>
      {canManageProducts && (
        <TabsContent value="catalog">
          <CatalogTab currentRole={currentRole} />
        </TabsContent>
      )}
      <TabsContent value="open-units">
        <OpenUnitsTab />
      </TabsContent>
      <TabsContent value="near-expiry">
        <NearExpiryTab />
      </TabsContent>
      <TabsContent value="movements">
        <MovementsTab />
      </TabsContent>
    </Tabs>
  );
}
