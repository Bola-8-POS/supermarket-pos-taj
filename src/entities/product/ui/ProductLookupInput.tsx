import { useId, useMemo } from 'react';
import type { Product } from '@shared/lib/domain';
import { cn } from '@shared/lib/utils';
import { Input } from '@shared/ui/input';
import { findProductByLookup } from '../model/product-lookup';

export type ProductLookupInputProps = {
  products: readonly Product[];
  /** Current free-text value (product name, barcode, or SKU). */
  value: string;
  /** Fires on every keystroke with the resolved product (or null when nothing matches). */
  onChange: (next: { search: string; product: Product | null }) => void;
  'aria-label': string;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  /** Marks the field invalid (unmatched text) for styling + `aria-invalid`. */
  invalid?: boolean | undefined;
  className?: string | undefined;
  /** Optional `id` for the field (FormField clones one in when wrapped). */
  id?: string | undefined;
};

/**
 * Text input backed by a native `<datalist>` so the browser offers product
 * names as you type (no dependency, works with barcode scanners that "type"
 * the code + Enter). A product is selected when the text exactly matches a
 * name, barcode, or SKU — the same rule receiving and purchase orders used
 * before, now shared.
 */
export function ProductLookupInput({
  products,
  value,
  onChange,
  placeholder,
  disabled,
  invalid,
  className,
  id,
  ...rest
}: ProductLookupInputProps) {
  const listId = useId();
  const options = useMemo(
    () =>
      products
        .filter(p => p.isActive)
        .map(p => ({ id: p.id, name: p.name, code: p.barcode ?? p.sku ?? '' })),
    [products]
  );
  return (
    <>
      <Input
        id={id}
        list={listId}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid ? 'true' : undefined}
        aria-label={rest['aria-label']}
        className={cn(className)}
        onChange={e => {
          const search = e.target.value;
          onChange({ search, product: findProductByLookup(products, search) });
        }}
      />
      <datalist id={listId}>
        {options.map(o => (
          <option key={o.id} value={o.name}>
            {o.code}
          </option>
        ))}
      </datalist>
    </>
  );
}
