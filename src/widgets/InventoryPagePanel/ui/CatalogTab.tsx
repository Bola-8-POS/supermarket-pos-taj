import { useTranslation } from 'react-i18next';
import { CategoryTreeEditor } from '@features/manage-categories';
import { ModifierGroupEditor } from '@features/manage-modifier-groups';
import { CatalogBrandsTab, CatalogModifiersTab, CatalogProductsTab } from '@features/manage-products';
import type { UserRole } from '@shared/lib/domain';
import { ProtectedAction } from '@shared/ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@shared/ui/tabs';

type Props = {
  currentRole: UserRole | null;
};

/**
 * Product catalog management (products, categories, modifiers, modifier
 * groups). Lived under Settings › Products until the 2026-09 UX pass; it is
 * inventory work, so it now renders as the Inventory page's "Catalog" tab.
 */
export function CatalogTab({ currentRole }: Props) {
  const { t } = useTranslation('wAdmin');
  return (
    <ProtectedAction action="manage_products" currentRole={currentRole}>
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{t('productsSettingsTab.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('productsSettingsTab.description')}</p>
        </div>
        <Tabs defaultValue="products" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="products">{t('productsSettingsTab.tabProducts')}</TabsTrigger>
            <TabsTrigger value="categories">{t('productsSettingsTab.tabCategories')}</TabsTrigger>
            <TabsTrigger value="modifiers">{t('productsSettingsTab.tabModifiers')}</TabsTrigger>
            <TabsTrigger value="modifier-groups">
              {t('productsSettingsTab.tabModifierGroups')}
            </TabsTrigger>
            <TabsTrigger value="brands">{t('productsSettingsTab.tabBrands')}</TabsTrigger>
          </TabsList>
          <TabsContent value="products">
            <CatalogProductsTab />
          </TabsContent>
          <TabsContent value="categories">
            <CategoryTreeEditor />
          </TabsContent>
          <TabsContent value="modifiers">
            <CatalogModifiersTab />
          </TabsContent>
          <TabsContent value="modifier-groups">
            <ModifierGroupEditor />
          </TabsContent>
          <TabsContent value="brands">
            <CatalogBrandsTab />
          </TabsContent>
        </Tabs>
      </div>
    </ProtectedAction>
  );
}
