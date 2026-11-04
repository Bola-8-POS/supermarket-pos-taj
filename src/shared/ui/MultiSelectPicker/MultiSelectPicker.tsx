/**
 * MultiSelectPicker
 *
 * Search-driven multi-select picker over two groups of items (e.g. products
 * and categories). Supports controlled multi-selection via
 * `selectedProductIds` / `selectedCategoryIds` + `onChange`. Category rows
 * are indented by `buildTree`-derived depth, mirroring CategoryTreePicker's
 * hierarchy rendering. Keyboard-accessible via the underlying cmdk `Command`
 * primitive (arrow keys navigate, Enter/Space selects).
 *
 * This is a PURE presentation component — it accepts flat products/
 * categories arrays and renders them locally. It does NOT fetch data.
 *
 * Copy is passed via props (English defaults, mirroring CategoryTreePicker's
 * `label`/`emptyText` convention) — this component does not call
 * `useTranslation` itself; the feature-layer consumer supplies localized
 * strings.
 */

import { useId, useMemo, useState } from 'react';
import { buildTree, type CategoryTreeNode, type TreeNode } from '@shared/lib/category-tree';
import { POSButton } from '../POSButton';
import { Badge } from '../badge';
import { Checkbox } from '../checkbox';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../command';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';

// ============================================================================
// TYPES
// ============================================================================

export interface MultiSelectProductItem {
  id: string;
  name: string;
}

export interface MultiSelectCategoryItem extends TreeNode {
  id: string;
  name: string;
  parentId: string | null | undefined;
}

export interface MultiSelectPickerProps {
  /** Flat list of selectable products. */
  products: MultiSelectProductItem[];
  /** Flat list of selectable categories (may include parentId for hierarchy). */
  categories: MultiSelectCategoryItem[];
  /** Currently selected product ids (controlled). */
  selectedProductIds: string[];
  /** Currently selected category ids (controlled). */
  selectedCategoryIds: string[];
  /** Called whenever the selection changes (toggle, or chip removal). */
  onChange: (next: { productIds: string[]; categoryIds: string[] }) => void;
  /** When true the picker is read-only (no click/keyboard interaction). */
  disabled?: boolean;
  /** Trigger button text when nothing is selected. */
  placeholderText?: string;
  /** Trigger button text when N items are selected. */
  selectedCountLabel?: (count: number) => string;
  /** CommandInput placeholder. */
  searchPlaceholder?: string;
  /** Heading for the products CommandGroup. */
  productsGroupLabel?: string;
  /** Heading for the categories CommandGroup. */
  categoriesGroupLabel?: string;
  /** CommandEmpty heading (no search matches). */
  emptyHeading?: string;
  /** CommandEmpty body (no search matches). */
  emptyBody?: string;
  /** aria-label for a chip's remove button, given the item's name. */
  removeLabel?: (name: string) => string;
}

// ============================================================================
// PUBLIC COMPONENT
// ============================================================================

export function MultiSelectPicker({
  products,
  categories,
  selectedProductIds,
  selectedCategoryIds,
  onChange,
  disabled = false,
  placeholderText = 'Select products or categories…',
  selectedCountLabel = count => `${String(count)} selected`,
  searchPlaceholder = 'Search products or categories…',
  productsGroupLabel = 'Products',
  categoriesGroupLabel = 'Categories',
  emptyHeading = 'No matches',
  emptyBody = 'Try a different product or category name.',
  removeLabel = name => `Remove ${name}`,
}: MultiSelectPickerProps) {
  const [open, setOpen] = useState(false);
  const labelId = useId();

  const categoryDepthById = useMemo(() => {
    const map = new Map<string, number>();
    function walk(nodes: CategoryTreeNode<MultiSelectCategoryItem>[]) {
      for (const treeNode of nodes) {
        map.set(treeNode.node.id, treeNode.depth);
        walk(treeNode.children);
      }
    }
    walk(buildTree(categories));
    return map;
  }, [categories]);

  const totalSelected = selectedProductIds.length + selectedCategoryIds.length;

  function toggleProduct(id: string) {
    const next = selectedProductIds.includes(id)
      ? selectedProductIds.filter(pid => pid !== id)
      : [...selectedProductIds, id];
    onChange({ productIds: next, categoryIds: selectedCategoryIds });
  }

  function toggleCategory(id: string) {
    const next = selectedCategoryIds.includes(id)
      ? selectedCategoryIds.filter(cid => cid !== id)
      : [...selectedCategoryIds, id];
    onChange({ productIds: selectedProductIds, categoryIds: next });
  }

  function removeProduct(id: string) {
    onChange({
      productIds: selectedProductIds.filter(pid => pid !== id),
      categoryIds: selectedCategoryIds,
    });
  }

  function removeCategory(id: string) {
    onChange({
      productIds: selectedProductIds,
      categoryIds: selectedCategoryIds.filter(cid => cid !== id),
    });
  }

  const selectedProducts = products.filter(p => selectedProductIds.includes(p.id));
  const selectedCategories = categories.filter(c => selectedCategoryIds.includes(c.id));

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="sr-only">
        {placeholderText}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <POSButton
            type="button"
            variant="outline"
            touchSize="default"
            disabled={disabled}
            className="w-full justify-start font-normal"
            aria-labelledby={labelId}
          >
            {totalSelected > 0 ? selectedCountLabel(totalSelected) : placeholderText}
          </POSButton>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command role="listbox" aria-multiselectable={true}>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>
                <p className="text-sm font-medium">{emptyHeading}</p>
                <p className="text-xs text-muted-foreground">{emptyBody}</p>
              </CommandEmpty>
              <CommandGroup heading={productsGroupLabel}>
                {products.map(product => {
                  const checked = selectedProductIds.includes(product.id);
                  return (
                    <CommandItem
                      key={product.id}
                      role="option"
                      aria-selected={checked}
                      data-checked={checked}
                      value={`product-${product.id}`}
                      keywords={[product.name]}
                      onSelect={() => {
                        toggleProduct(product.id);
                      }}
                    >
                      <Checkbox checked={checked} className="pointer-events-none" tabIndex={-1} />
                      <span className="min-w-0 flex-1 truncate">{product.name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              <CommandGroup heading={categoriesGroupLabel}>
                {categories.map(category => {
                  const checked = selectedCategoryIds.includes(category.id);
                  const depth = categoryDepthById.get(category.id) ?? 0;
                  return (
                    <CommandItem
                      key={category.id}
                      role="option"
                      aria-selected={checked}
                      data-checked={checked}
                      value={`category-${category.id}`}
                      keywords={[category.name]}
                      style={{ paddingLeft: `${String(depth * 20 + 8)}px` }}
                      onSelect={() => {
                        toggleCategory(category.id);
                      }}
                    >
                      <Checkbox checked={checked} className="pointer-events-none" tabIndex={-1} />
                      <span className="min-w-0 flex-1 truncate">{category.name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {totalSelected > 0 && (
        <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
          {selectedProducts.map(product => (
            <Badge key={product.id} variant="secondary" className="gap-1">
              <span className="max-w-[12rem] truncate" title={product.name}>
                {product.name}
              </span>
              <button
                type="button"
                aria-label={removeLabel(product.name)}
                disabled={disabled}
                className="ml-1 rounded-full text-muted-foreground hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  removeProduct(product.id);
                }}
              >
                ×
              </button>
            </Badge>
          ))}
          {selectedCategories.map(category => (
            <Badge key={category.id} variant="secondary" className="gap-1">
              <span className="max-w-[12rem] truncate" title={category.name}>
                {category.name}
              </span>
              <button
                type="button"
                aria-label={removeLabel(category.name)}
                disabled={disabled}
                className="ml-1 rounded-full text-muted-foreground hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  removeCategory(category.id);
                }}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
