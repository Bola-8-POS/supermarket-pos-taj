import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';
import {
  MultiSelectPicker,
  type MultiSelectCategoryItem,
  type MultiSelectProductItem,
} from './MultiSelectPicker';

// ============================================================================
// FIXTURES
// ============================================================================

const PRODUCT_A: MultiSelectProductItem = { id: 'p-a', name: 'Aashirvaad Atta 5kg' };
const PRODUCT_B: MultiSelectProductItem = { id: 'p-b', name: 'Basmati Rice 5kg' };

const CATEGORY_A: MultiSelectCategoryItem = { id: 'c-a', parentId: null, name: 'Staples' };
const CATEGORY_B: MultiSelectCategoryItem = { id: 'c-b', parentId: 'c-a', name: 'Rice & Grains' };

const PRODUCTS = [PRODUCT_A, PRODUCT_B];
const CATEGORIES = [CATEGORY_A, CATEGORY_B];

async function openPicker() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /select products or categories/i }));
  return user;
}

// ============================================================================
// TESTS
// ============================================================================

describe('MultiSelectPicker', () => {
  it('clicking a product row adds it to selectedProductIds via onChange', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <MultiSelectPicker
        products={PRODUCTS}
        categories={CATEGORIES}
        selectedProductIds={[]}
        selectedCategoryIds={[]}
        onChange={onChange}
      />
    );
    const user = await openPicker();
    await user.click(await screen.findByText(PRODUCT_A.name));
    expect(onChange).toHaveBeenCalledWith({ productIds: [PRODUCT_A.id], categoryIds: [] });
  });

  it('clicking an already-selected row removes it', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <MultiSelectPicker
        products={PRODUCTS}
        categories={CATEGORIES}
        selectedProductIds={[PRODUCT_A.id]}
        selectedCategoryIds={[]}
        onChange={onChange}
      />
    );
    const user = await openPicker();
    await user.click(await screen.findByRole('option', { name: PRODUCT_A.name }));
    expect(onChange).toHaveBeenCalledWith({ productIds: [], categoryIds: [] });
  });

  it('clicking a category row adds it to selectedCategoryIds via onChange', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <MultiSelectPicker
        products={PRODUCTS}
        categories={CATEGORIES}
        selectedProductIds={[]}
        selectedCategoryIds={[]}
        onChange={onChange}
      />
    );
    const user = await openPicker();
    await user.click(await screen.findByText(CATEGORY_A.name));
    expect(onChange).toHaveBeenCalledWith({ productIds: [], categoryIds: [CATEGORY_A.id] });
  });

  it('the search input filters visible CommandItems', async () => {
    renderWithProviders(
      <MultiSelectPicker
        products={PRODUCTS}
        categories={CATEGORIES}
        selectedProductIds={[]}
        selectedCategoryIds={[]}
        onChange={vi.fn()}
      />
    );
    const user = await openPicker();
    expect(await screen.findByText(PRODUCT_A.name)).toBeInTheDocument();
    expect(screen.getByText(PRODUCT_B.name)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/search products or categories/i), 'Basmati');
    expect(screen.queryByText(PRODUCT_A.name)).not.toBeInTheDocument();
    expect(screen.getByText(PRODUCT_B.name)).toBeInTheDocument();
  });

  it('CommandEmpty renders on a no-match search', async () => {
    renderWithProviders(
      <MultiSelectPicker
        products={PRODUCTS}
        categories={CATEGORIES}
        selectedProductIds={[]}
        selectedCategoryIds={[]}
        onChange={vi.fn()}
      />
    );
    const user = await openPicker();
    await user.type(
      await screen.findByPlaceholderText(/search products or categories/i),
      'zzz-no-match-zzz'
    );
    expect(await screen.findByText('No matches')).toBeInTheDocument();
    expect(screen.getByText('Try a different product or category name.')).toBeInTheDocument();
  });

  it('removing a chip via its × button calls onChange without the removed id', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <MultiSelectPicker
        products={PRODUCTS}
        categories={CATEGORIES}
        selectedProductIds={[PRODUCT_A.id, PRODUCT_B.id]}
        selectedCategoryIds={[]}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole('button', { name: `Remove ${PRODUCT_A.name}` }));
    expect(onChange).toHaveBeenCalledWith({ productIds: [PRODUCT_B.id], categoryIds: [] });
  });

  it('does not toggle selection when disabled', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <MultiSelectPicker
        products={PRODUCTS}
        categories={CATEGORIES}
        selectedProductIds={[]}
        selectedCategoryIds={[]}
        onChange={onChange}
        disabled
      />
    );
    const trigger = screen.getByRole('button', { name: /select products or categories/i });
    expect(trigger).toBeDisabled();
  });
});
