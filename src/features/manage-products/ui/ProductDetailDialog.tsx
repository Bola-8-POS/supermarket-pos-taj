import { FileText, Image as ImageIcon, Link2 } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import type { CreateProductInput, UpdateProductInput } from '@entities/product';
import type { Brand, Category, Modifier, Product, Supplier } from '@shared/lib/domain';
import { ProductCreateSchema, ProductUpdateSchema, UuidSchema } from '@shared/lib/domain';
import { ConfirmDialog } from '@shared/ui/ConfirmDialog';
import { POSButton } from '@shared/ui/POSButton';
import { Badge } from '@shared/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Tabs, TabsContent } from '@shared/ui/tabs';
import { VerticalTabsList, VerticalTabsTrigger } from '@shared/ui/vertical-tabs';
import { firstImageFromClipboard } from '../model/photo-file';
import {
  firstErroringTab,
  isProductFormDirty,
  tabsWithErrors,
  type ProductDialogTabId,
  type ProductFormSnapshot,
} from '../model/productDialogTabs';
import { ProductDetailsTab } from './tabs/ProductDetailsTab';
import { ProductLinksTab } from './tabs/ProductLinksTab';
import { ProductPhotoTab, type ProductPhotoTabHandle } from './tabs/ProductPhotoTab';

const ModifierIdsSchema = z.array(UuidSchema);

export type ProductDetailDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: Category[];
  modifiers: Modifier[];
  /** Phase 32 D-08: brand-select options, sorted alphabetically (D-01: no sortOrder field). */
  brands: Brand[];
  /** All catalog products — used to populate the parent-package selector. */
  products: Product[];
  suppliers: Supplier[];
  supplierIds?: readonly string[] | undefined;
  /** `null` (or omitted) = create mode. */
  initialProduct?: Product | null;
  submitting?: boolean;
  onSubmitCreate: (payload: CreateProductInput) => void;
  onSubmitUpdate: (payload: UpdateProductInput) => void;
};

/**
 * Single host for the Details / Photo / Links tabs (Phase 31 D-01..D-03).
 * Replaces the old two-`Dialog` split in `CatalogProductsTab`. Field state,
 * Zod parsing, and error flattening are lifted verbatim from the retired
 * `ProductForm.tsx` — the tab split is purely visual (D-05).
 */
export function ProductDetailDialog({
  open,
  onOpenChange,
  categories,
  modifiers,
  brands,
  products,
  suppliers,
  supplierIds,
  initialProduct = null,
  submitting = false,
  onSubmitCreate,
  onSubmitUpdate,
}: ProductDetailDialogProps) {
  const { t } = useTranslation('featMgmt');
  const isEdit = initialProduct != null;

  const [activeTab, setActiveTab] = useState<ProductDialogTabId>('details');

  const [name, setName] = useState(initialProduct?.name ?? '');
  const [categoryId, setCategoryId] = useState(
    initialProduct?.categoryId ?? categories[0]?.id ?? ''
  );
  const [basePrice, setBasePrice] = useState(initialProduct?.basePrice ?? 0);
  const [sku, setSku] = useState(initialProduct?.sku ?? '');
  const [barcode, setBarcode] = useState(initialProduct?.barcode ?? '');
  const [unitsPerPackageInput, setUnitsPerPackageInput] = useState(
    initialProduct?.unitsPerPackage != null ? String(initialProduct.unitsPerPackage) : ''
  );
  const [parentProductIdInput, setParentProductIdInput] = useState(
    initialProduct?.parentProductId ?? ''
  );
  const [brandId, setBrandId] = useState(initialProduct?.brandId ?? '');
  const [weightAmountInput, setWeightAmountInput] = useState(
    initialProduct?.weightAmount != null ? String(initialProduct.weightAmount) : ''
  );
  // D-09: pre-selected default, purely a UI initial value — never read into the
  // submit payload unless weightAmountInput is also non-empty (Pattern 2/Pitfall 2).
  // eslint-disable-next-line i18next/no-literal-string -- 'g' is a weight-unit enum value (data), not UI copy.
  const [weightUnit, setWeightUnit] = useState<string>(initialProduct?.weightUnit ?? 'g');
  const [isActive, setIsActive] = useState(initialProduct?.isActive ?? true);
  const [comboEligible, setComboEligible] = useState(initialProduct?.comboEligible ?? true);
  const [imageUrl, setImageUrl] = useState(initialProduct?.imageUrl ?? '');
  const [modifierIds, setModifierIds] = useState<string[]>(
    () => initialProduct?.modifiers.map(m => m.id) ?? []
  );
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<string[]>(() => [
    ...(supplierIds ?? []),
  ]);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const photoTabRef = useRef<ProductPhotoTabHandle>(null);

  // D-09: paste is a first-class photo entry path, but only while the Photo
  // tab is the active one — a paste into a Details or Links input (e.g. the
  // SKU field) must never be intercepted and routed into the upload pipeline.
  function handleDialogPaste(e: ClipboardEvent<HTMLDivElement>): void {
    if (activeTab !== 'photo' || !isEdit) return;
    const file = firstImageFromClipboard(e.clipboardData);
    if (file) {
      e.preventDefault();
      photoTabRef.current?.handleFile(file);
    }
  }

  // D-07 dirty-close guard: captured once at mount. A create-then-stay
  // transition or opening a different product both remount this component
  // (CatalogProductsTab keys it by product id), which re-runs this lazy
  // initializer — that is the re-baseline, not a live effect.
  const [initialSnapshot] = useState<ProductFormSnapshot>(() => ({
    name: initialProduct?.name ?? '',
    categoryId: initialProduct?.categoryId ?? categories[0]?.id ?? '',
    basePrice: initialProduct?.basePrice ?? 0,
    sku: initialProduct?.sku ?? '',
    barcode: initialProduct?.barcode ?? '',
    unitsPerPackageInput:
      initialProduct?.unitsPerPackage != null ? String(initialProduct.unitsPerPackage) : '',
    parentProductIdInput: initialProduct?.parentProductId ?? '',
    brandId: initialProduct?.brandId ?? '',
    weightAmountInput:
      initialProduct?.weightAmount != null ? String(initialProduct.weightAmount) : '',
    // eslint-disable-next-line i18next/no-literal-string -- 'g' is a weight-unit enum value (data), not UI copy.
    weightUnit: initialProduct?.weightUnit ?? 'g',
    isActive: initialProduct?.isActive ?? true,
    comboEligible: initialProduct?.comboEligible ?? true,
    imageUrl: initialProduct?.imageUrl ?? '',
    modifierIds: initialProduct?.modifiers.map(m => m.id) ?? [],
    selectedSupplierIds: [...(supplierIds ?? [])],
  }));

  function currentSnapshot(): ProductFormSnapshot {
    return {
      name,
      categoryId,
      basePrice,
      sku,
      barcode,
      unitsPerPackageInput,
      parentProductIdInput,
      brandId,
      weightAmountInput,
      weightUnit,
      isActive,
      comboEligible,
      imageUrl,
      modifierIds,
      selectedSupplierIds,
    };
  }

  // D-07: X, Esc, outside-click, and Cancel all route through this — dirty
  // opens the discard-confirm dialog; not dirty closes immediately. Tab
  // switching never calls this, so it stays free per the spec.
  function requestClose() {
    if (isProductFormDirty(initialSnapshot, currentSnapshot())) {
      // Opening the ConfirmDialog synchronously, from inside the outer
      // Dialog's own Escape-key dismiss handler, races Radix's
      // DismissableLayer: the new AlertDialog layer can mount and register
      // its own document-level Escape listener while the SAME native
      // keydown event is still finishing its dispatch, so the fresh layer
      // immediately dismisses itself. Deferring to the next macrotask lets
      // the triggering event finish first — a real fix, not just a test
      // workaround, since a real user pressing Esc would hit the identical
      // flicker/self-close.
      setTimeout(() => {
        setDiscardConfirmOpen(true);
      }, 0);
    } else {
      onOpenChange(false);
    }
  }

  // Same sanctioned backfill pattern as the retired `ProductForm.tsx` — the
  // categoryId initializer above only runs once, at mount, so if the dialog
  // opens before `useCategories()` resolves, categoryId is permanently stuck
  // at '' unless re-synced here once categories arrive.
  useEffect(() => {
    const firstCategoryId = categories[0]?.id;
    if (categoryId === '' && firstCategoryId != null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCategoryId(firstCategoryId);
    }
  }, [categories, categoryId]);

  useEffect(() => {
    if (supplierIds) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async query result initializes edit form
      setSelectedSupplierIds([...supplierIds]);
    }
  }, [supplierIds]);

  // D-06: after a submit produces field errors, jump to the first tab that
  // owns one (rail order breaks ties) and move focus to its first invalid
  // control. Runs after the DOM reflects the (possibly new) activeTab.
  useEffect(() => {
    if (Object.keys(fieldErrors).length === 0) return;
    // eslint-disable-next-line i18next/no-literal-string -- CSS attribute selector, not UI copy
    const el = panelRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    el?.focus();
  }, [fieldErrors]);

  const errorTabs = useMemo(() => tabsWithErrors(fieldErrors), [fieldErrors]);

  function errorBadgeFor(tab: ProductDialogTabId): ReactNode {
    return errorTabs.has(tab) ? (
      <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
    ) : undefined;
  }

  function labelWithErrorSuffix(tab: ProductDialogTabId, label: string): string {
    return errorTabs.has(tab) ? t('manageProducts.productDialog.tabWithErrors', { label }) : label;
  }

  function applyFieldErrors(next: Record<string, string>) {
    setFieldErrors(next);
    const target = firstErroringTab(next);
    if (target && target !== activeTab) {
      setActiveTab(target);
    }
  }

  const sortedModifiers = useMemo(
    () => [...modifiers].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [modifiers]
  );

  // Only a configured package product (units-per-package set) is a legal
  // parent, and a product can never be its own parent (D-01/T-27-18).
  const parentPackageOptions = useMemo(
    () =>
      products
        .filter(p => p.unitsPerPackage != null && p.id !== initialProduct?.id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [products, initialProduct?.id]
  );

  function toggleModifier(id: string) {
    setModifierIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }

  function toggleSupplier(id: string) {
    setSelectedSupplierIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});

    const modParsed = ModifierIdsSchema.safeParse(modifierIds);
    if (!modParsed.success) {
      applyFieldErrors({ modifiers: t('manageProducts.productForm.invalidModifierSelection') });
      return;
    }

    const skuVal = sku.trim() === '' ? null : sku.trim();
    const imageVal = imageUrl.trim() === '' ? null : imageUrl.trim();
    const barcodeVal = barcode.trim() === '' ? null : barcode.trim();
    const parentProductId = parentProductIdInput === '' ? null : parentProductIdInput;

    let unitsPerPackage: number | null = null;
    if (unitsPerPackageInput.trim() !== '') {
      const trimmedUnits = unitsPerPackageInput.trim();
      // Reject any non-whole-number entry (e.g. "2.5", "1e2") before parsing —
      // Number.parseInt would otherwise silently truncate it to a different,
      // wrong integer instead of failing validation (WR-01).
      if (!/^\d+$/.test(trimmedUnits)) {
        applyFieldErrors({
          unitsPerPackage: t('manageProducts.productForm.unitsPerPackageMinError'),
        });
        return;
      }
      const parsedUnits = Number.parseInt(trimmedUnits, 10);
      if (!Number.isFinite(parsedUnits) || parsedUnits < 1) {
        applyFieldErrors({
          unitsPerPackage: t('manageProducts.productForm.unitsPerPackageMinError'),
        });
        return;
      }
      unitsPerPackage = parsedUnits;
    }

    const brandIdVal = brandId === '' ? null : brandId;
    // Pattern 2/Pitfall 2 (D-09): the payload's weight unit is non-null ONLY
    // when amount is also non-null, regardless of the select's pre-selected
    // 'g' state — otherwise every untouched save would submit a phantom unit.
    const weightAmount = weightAmountInput.trim() === '' ? null : Number(weightAmountInput.trim());
    const payloadWeightUnit = weightAmount === null ? null : weightUnit;

    // happyHourPrice is always null — happy-hour pricing is managed in
    // Settings → Promotions (D-01); the vestigial nullable Zod field must
    // still be present in the parsed payload.
    //
    // stock_threshold has no input in this dialog (set via a separate
    // low-stock-alert flow) but ProductSchema requires the key present
    // (nullable, not optional) — omitting it fails safeParse with a silent,
    // invisible field error on a key this dialog has no control for.
    // Preserve the existing value on edit; default to null on create.
    if (initialProduct != null) {
      const parsed = ProductUpdateSchema.safeParse({
        id: initialProduct.id,
        name,
        categoryId,
        basePrice,
        happyHourPrice: null,
        sku: skuVal,
        isActive,
        comboEligible,
        imageUrl: imageVal,
        barcode: barcodeVal,
        unitsPerPackage,
        parentProductId,
        brandId: brandIdVal,
        weightAmount,
        weightUnit: payloadWeightUnit,
        stock_threshold: initialProduct.stock_threshold ?? null,
      });
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error);
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(flat.fieldErrors)) {
          const first = Array.isArray(v) ? v[0] : undefined;
          if (first) next[k] = first;
        }
        if (Object.keys(next).length === 0 && parsed.error.issues[0]) {
          next._form = parsed.error.issues[0].message;
        }
        applyFieldErrors(next);
        return;
      }
      onSubmitUpdate({
        ...parsed.data,
        modifierIds: modParsed.data,
        supplierIds: selectedSupplierIds,
      });
      return;
    }

    // photoPath is a required (nullable) key on ProductSchema (Phase 31
    // D-16) — a new product has no photo yet, since uploading one requires
    // a real product id (D-03 create-then-stay).
    const parsed = ProductCreateSchema.safeParse({
      name,
      categoryId,
      basePrice,
      happyHourPrice: null,
      sku: skuVal,
      isActive,
      comboEligible,
      imageUrl: imageVal,
      photoPath: null,
      barcode: barcodeVal,
      unitsPerPackage,
      parentProductId,
      brandId: brandIdVal,
      weightAmount,
      weightUnit: payloadWeightUnit,
      stock_threshold: null,
    });
    if (!parsed.success) {
      const flat = z.flattenError(parsed.error);
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(flat.fieldErrors)) {
        const first = Array.isArray(v) ? v[0] : undefined;
        if (first) next[k] = first;
      }
      if (Object.keys(next).length === 0 && parsed.error.issues[0]) {
        next._form = parsed.error.issues[0].message;
      }
      applyFieldErrors(next);
      return;
    }

    onSubmitCreate({
      ...parsed.data,
      modifierIds: modParsed.data,
      supplierIds: selectedSupplierIds,
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={next => {
        // D-07: only a genuine close attempt (X / Esc / outside click) runs
        // through the dirty check — Radix only ever calls this with `false`
        // here, since `open` itself is controlled by the parent.
        if (!next) {
          requestClose();
        }
      }}
    >
      <DialogContent
        className="flex max-h-[80vh] max-w-4xl flex-col overflow-hidden sm:max-w-4xl"
        showCloseButton
        onPaste={handleDialogPaste}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>
            {isEdit
              ? t('manageProducts.productsTab.editProductTitle')
              : t('manageProducts.productsTab.newProductTitle')}
          </DialogTitle>
          {isEdit ? (
            <div
              data-testid="product-stock-strip"
              className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-2"
            >
              <div className="flex flex-col gap-1">
                <span className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                  {t('manageProducts.productDialog.stockStrip.onHand')}
                </span>
                <span className="flex items-center gap-2 text-sm font-semibold text-numeric">
                  {initialProduct.quantityOnHand ?? 0}
                  {initialProduct.lowStockThreshold != null &&
                  (initialProduct.quantityOnHand ?? 0) <= initialProduct.lowStockThreshold ? (
                    <Badge variant="warning">
                      {t('manageProducts.productDialog.stockStrip.lowStock')}
                    </Badge>
                  ) : null}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                  {t('manageProducts.productDialog.stockStrip.threshold')}
                </span>
                <span className="text-sm font-semibold text-numeric">
                  {initialProduct.lowStockThreshold ??
                    t('manageProducts.productDialog.stockStrip.noThreshold')}
                </span>
              </div>
              <Badge variant={initialProduct.isActive ? 'success' : 'muted'}>
                {initialProduct.isActive
                  ? t('manageProducts.productsTab.active')
                  : t('manageProducts.productsTab.inactive')}
              </Badge>
            </div>
          ) : null}
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
        >
          <Tabs
            value={activeTab}
            onValueChange={v => {
              setActiveTab(v as ProductDialogTabId);
            }}
            orientation="vertical"
            className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]"
          >
            <VerticalTabsList
              aria-label={t('manageProducts.productDialog.navLabel')}
              className="self-start"
            >
              <VerticalTabsTrigger
                value="details"
                icon={FileText}
                label={labelWithErrorSuffix(
                  'details',
                  t('manageProducts.productDialog.tabs.details')
                )}
                description={t('manageProducts.productDialog.tabs.detailsDescription')}
                badge={errorBadgeFor('details')}
                disabled={submitting}
              />
              <VerticalTabsTrigger
                value="photo"
                icon={ImageIcon}
                label={t('manageProducts.productDialog.tabs.photo')}
                description={
                  isEdit
                    ? t('manageProducts.productDialog.tabs.photoDescription')
                    : t('manageProducts.productDialog.photo.lockedTitle')
                }
                disabled={submitting || !isEdit}
              />
              <VerticalTabsTrigger
                value="links"
                icon={Link2}
                label={labelWithErrorSuffix('links', t('manageProducts.productDialog.tabs.links'))}
                description={t('manageProducts.productDialog.tabs.linksDescription')}
                badge={errorBadgeFor('links')}
                disabled={submitting}
              />
            </VerticalTabsList>

            <div ref={panelRef} className="min-h-0 overflow-y-auto">
              <TabsContent
                value="details"
                className="rounded-xl border border-border bg-card p-4 shadow-xs lg:p-6"
              >
                <ProductDetailsTab
                  name={name}
                  onNameChange={setName}
                  categories={categories}
                  categoryId={categoryId}
                  onCategoryIdChange={setCategoryId}
                  brands={brands}
                  brandId={brandId}
                  onBrandIdChange={setBrandId}
                  weightAmountInput={weightAmountInput}
                  onWeightAmountInputChange={setWeightAmountInput}
                  weightUnit={weightUnit}
                  onWeightUnitChange={setWeightUnit}
                  basePrice={basePrice}
                  onBasePriceChange={setBasePrice}
                  sku={sku}
                  onSkuChange={setSku}
                  barcode={barcode}
                  onBarcodeChange={setBarcode}
                  isActive={isActive}
                  onIsActiveChange={setIsActive}
                  comboEligible={comboEligible}
                  onComboEligibleChange={setComboEligible}
                  fieldErrors={fieldErrors}
                  submitting={submitting}
                />
              </TabsContent>
              <TabsContent
                value="photo"
                className="rounded-xl border border-border bg-card p-4 shadow-xs lg:p-6"
              >
                {isEdit ? (
                  <ProductPhotoTab
                    ref={photoTabRef}
                    product={initialProduct}
                    submitting={submitting}
                  />
                ) : null}
              </TabsContent>
              <TabsContent
                value="links"
                className="rounded-xl border border-border bg-card p-4 shadow-xs lg:p-6"
              >
                <ProductLinksTab
                  unitsPerPackageInput={unitsPerPackageInput}
                  onUnitsPerPackageInputChange={setUnitsPerPackageInput}
                  parentProductIdInput={parentProductIdInput}
                  onParentProductIdInputChange={setParentProductIdInput}
                  parentPackageOptions={parentPackageOptions}
                  imageUrl={imageUrl}
                  onImageUrlChange={setImageUrl}
                  sortedModifiers={sortedModifiers}
                  modifierIds={modifierIds}
                  onToggleModifier={toggleModifier}
                  suppliers={suppliers}
                  selectedSupplierIds={selectedSupplierIds}
                  onToggleSupplier={toggleSupplier}
                  fieldErrors={fieldErrors}
                  submitting={submitting}
                />
              </TabsContent>
            </div>
          </Tabs>

          <DialogFooter showCloseButton={false}>
            {fieldErrors._form ? (
              <p role="alert" className="mr-auto text-sm text-destructive">
                {fieldErrors._form}
              </p>
            ) : null}
            <POSButton
              type="button"
              variant="outline"
              touchSize="default"
              disabled={submitting}
              onClick={requestClose}
            >
              {t('common:actions.cancel')}
            </POSButton>
            <POSButton
              type="submit"
              touchSize="default"
              focusEmphasis="high"
              disabled={submitting || categories.length === 0}
            >
              {submitting
                ? t('common:actions.saving')
                : isEdit
                  ? t('manageProducts.productForm.saveProduct')
                  : t('manageProducts.productForm.createProduct')}
            </POSButton>
          </DialogFooter>
        </form>
      </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discardConfirmOpen}
        title={t('manageProducts.productDialog.discardTitle')}
        description={t('manageProducts.productDialog.discardDescription')}
        confirmLabel={t('manageProducts.productDialog.discardConfirmLabel')}
        cancelLabel={t('manageProducts.productDialog.keepEditing')}
        variant="destructive"
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          onOpenChange(false);
        }}
        onCancel={() => {
          setDiscardConfirmOpen(false);
        }}
      />
    </>
  );
}
