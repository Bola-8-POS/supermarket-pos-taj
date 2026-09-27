/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useId, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import type { Supplier } from '@entities/supplier';
import { useSupplierProductIds } from '@entities/supplier';
import type { Product, SupplierCreate, SupplierUpdate } from '@shared/lib/domain';
import { SupplierCreateSchema } from '@shared/lib/domain';
import { FormField } from '@shared/ui/FormField';
import { POSButton } from '@shared/ui/POSButton';
import { ScrollArea } from '@shared/ui/ScrollArea';
import { SearchInput } from '@shared/ui/SearchInput';
import { Badge } from '@shared/ui/badge';
import { Checkbox } from '@shared/ui/checkbox';
import { DialogFooter } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { Textarea } from '@shared/ui/textarea';

type Payload = SupplierCreate & { productIds: string[] };

export type SupplierFormProps = {
  initialSupplier?: Supplier | null;
  products: Product[];
  submitting?: boolean;
  onSubmitCreate: (payload: Payload) => void;
  onSubmitUpdate: (payload: SupplierUpdate & { productIds: string[] }) => void;
  onCancel: () => void;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function SectionHeading({
  id,
  title,
  hint,
  aside,
}: {
  id: string;
  title: string;
  hint: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <h3 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {aside}
    </div>
  );
}

/**
 * Create/edit supplier form body. Lives inside a `DialogContent` — the host
 * renders `DialogHeader`, this renders the sections + `DialogFooter`, matching
 * `ProductDetailDialog` / `PromotionDialog`.
 */
export function SupplierForm({
  initialSupplier,
  products,
  submitting = false,
  onSubmitCreate,
  onSubmitUpdate,
  onCancel,
}: SupplierFormProps) {
  const { t } = useTranslation('featMgmt');
  const isEdit = initialSupplier != null;
  const detailsId = useId();
  const productsId = useId();
  const { data: linked } = useSupplierProductIds(initialSupplier?.id);

  const [name, setName] = useState(initialSupplier?.name ?? '');
  const [contactName, setContactName] = useState(initialSupplier?.contactName ?? '');
  const [phone, setPhone] = useState(initialSupplier?.phone ?? '');
  const [email, setEmail] = useState(initialSupplier?.email ?? '');
  const [address, setAddress] = useState(initialSupplier?.address ?? '');
  const [notes, setNotes] = useState(initialSupplier?.notes ?? '');
  const [productIds, setProductIds] = useState<string[]>([]);
  const [productQuery, setProductQuery] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Linked products arrive async in edit mode; the host remounts this form
  // per supplier (keyed), so a one-shot sync is enough.
  useEffect(() => {
    if (linked) setProductIds(linked);
  }, [linked]);

  const visibleProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      p =>
        p.name.toLowerCase().includes(q) ||
        (p.barcode?.includes(q) ?? false) ||
        (p.sku?.toLowerCase().includes(q) ?? false)
    );
  }, [products, productQuery]);

  const toggle = (id: string) => {
    setProductIds(x => (x.includes(id) ? x.filter(v => v !== id) : [...x, id]));
  };
  const nil = (value: string) => value.trim() || null;

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('manageSuppliers.supplierForm.nameRequired');
    const emailValue = nil(email);
    if (emailValue && !EMAIL_RE.test(emailValue))
      errors.email = t('manageSuppliers.supplierForm.emailInvalid');

    const parsed = SupplierCreateSchema.safeParse({
      name: name.trim(),
      contactName: nil(contactName),
      phone: nil(phone),
      email: emailValue,
      address: nil(address),
      notes: nil(notes),
    });
    if (!parsed.success) {
      for (const key of Object.keys(z.flattenError(parsed.error).fieldErrors)) {
        errors[key] ??= t('manageSuppliers.supplierForm.invalidField');
      }
    }
    if (Object.keys(errors).length > 0 || !parsed.success) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    if (initialSupplier) {
      onSubmitUpdate({ ...parsed.data, id: initialSupplier.id, productIds });
    } else {
      onSubmitCreate({ ...parsed.data, productIds });
    }
  };

  return (
    <form className="space-y-6" onSubmit={submit} noValidate>
      <section aria-labelledby={detailsId} className="space-y-4">
        <SectionHeading
          id={detailsId}
          title={t('manageSuppliers.supplierForm.sectionDetails')}
          hint={t('manageSuppliers.supplierForm.sectionDetailsHint')}
        />
        <FormField
          label={t('manageSuppliers.supplierForm.name')}
          required
          error={fieldErrors.name ?? ''}
        >
          <Input
            value={name}
            maxLength={150}
            onChange={e => {
              setName(e.target.value);
            }}
            disabled={submitting}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t('manageSuppliers.supplierForm.contactName')}
            error={fieldErrors.contactName ?? ''}
          >
            <Input
              value={contactName}
              maxLength={120}
              autoComplete="off"
              onChange={e => {
                setContactName(e.target.value);
              }}
              disabled={submitting}
            />
          </FormField>
          <FormField
            label={t('manageSuppliers.supplierForm.phone')}
            error={fieldErrors.phone ?? ''}
          >
            <Input
              type="tel"
              inputMode="tel"
              value={phone}
              maxLength={30}
              autoComplete="off"
              onChange={e => {
                setPhone(e.target.value);
              }}
              disabled={submitting}
            />
          </FormField>
        </div>
        <FormField label={t('manageSuppliers.supplierForm.email')} error={fieldErrors.email ?? ''}>
          <Input
            type="email"
            inputMode="email"
            value={email}
            maxLength={255}
            autoComplete="off"
            onChange={e => {
              setEmail(e.target.value);
            }}
            disabled={submitting}
          />
        </FormField>
        <FormField
          label={t('manageSuppliers.supplierForm.address')}
          error={fieldErrors.address ?? ''}
        >
          <Textarea
            rows={2}
            className="min-h-0"
            value={address}
            maxLength={300}
            onChange={e => {
              setAddress(e.target.value);
            }}
            disabled={submitting}
          />
        </FormField>
        <FormField label={t('manageSuppliers.supplierForm.notes')} error={fieldErrors.notes ?? ''}>
          <Textarea
            rows={2}
            className="min-h-0"
            value={notes}
            maxLength={500}
            onChange={e => {
              setNotes(e.target.value);
            }}
            disabled={submitting}
          />
        </FormField>
      </section>

      <section aria-labelledby={productsId} className="space-y-3">
        <SectionHeading
          id={productsId}
          title={t('manageSuppliers.supplierForm.sectionProducts')}
          hint={t('manageSuppliers.supplierForm.sectionProductsHint')}
          aside={
            <Badge variant={productIds.length ? 'brand' : 'muted'} className="shrink-0">
              {t('manageSuppliers.supplierForm.selectedCount', { count: productIds.length })}
            </Badge>
          }
        />
        {products.length > 0 ? (
          <>
            <SearchInput
              value={productQuery}
              onChange={setProductQuery}
              placeholder={t('manageSuppliers.supplierForm.searchProducts')}
              debounceMs={150}
            />
            <ScrollArea className="max-h-56 rounded-lg border border-border bg-card p-2">
              {visibleProducts.length > 0 ? (
                <ul className="space-y-1 pr-2">
                  {visibleProducts.map(product => {
                    const checked = productIds.includes(product.id);
                    return (
                      <li key={product.id}>
                        <label
                          htmlFor={`supplier-product-${product.id}`}
                          className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
                        >
                          <Checkbox
                            id={`supplier-product-${product.id}`}
                            checked={checked}
                            onCheckedChange={() => {
                              toggle(product.id);
                            }}
                            disabled={submitting}
                          />
                          <span className="min-w-0 flex-1 truncate">{product.name}</span>
                          {product.barcode || product.sku ? (
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              {product.barcode ?? product.sku}
                            </span>
                          ) : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-2 py-3 text-sm text-muted-foreground">
                  {t('manageSuppliers.supplierForm.noMatches')}
                </p>
              )}
            </ScrollArea>
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            {t('manageSuppliers.supplierForm.noProductsDefined')}
          </p>
        )}
      </section>

      <DialogFooter showCloseButton={false}>
        <POSButton
          type="button"
          variant="outline"
          touchSize="default"
          disabled={submitting}
          onClick={onCancel}
        >
          {t('common:actions.cancel')}
        </POSButton>
        <POSButton
          type="submit"
          variant="brand"
          touchSize="default"
          focusEmphasis="high"
          disabled={submitting}
        >
          {submitting
            ? t('common:actions.saving')
            : isEdit
              ? t('manageSuppliers.supplierForm.save')
              : t('manageSuppliers.supplierForm.create')}
        </POSButton>
      </DialogFooter>
    </form>
  );
}
