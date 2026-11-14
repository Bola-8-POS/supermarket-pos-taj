import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Category, Product } from '@shared/lib/domain';
import '@shared/lib/i18n';
import { ProductDetailDialog } from './ProductDetailDialog';

const CATEGORY: Category = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Biscuits',
  color: '#6366f1',
  sortOrder: 0,
  happyHourStart: null,
  happyHourEnd: null,
  routing: 'NONE',
  parentId: null,
  comboEligible: true,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

const PRODUCT: Product = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Parle-G Biscuits',
  categoryId: CATEGORY.id,
  basePrice: 25,
  happyHourPrice: null,
  sku: null,
  isActive: true,
  soldByWeight: false,
  imageUrl: null,
  photoPath: null,
  stock_threshold: null,
  barcode: null,
  unitsPerPackage: null,
  parentProductId: null,
  brandId: null,
  weightAmount: null,
  weightUnit: null,
  comboEligible: true,
  isCombo: false,
  comboPriceOverride: null,
  modifiers: [],
};

describe('ProductDetailDialog — combo eligible toggle', () => {
  it('sends comboEligible:false in the update payload when unchecked', async () => {
    const onSubmitUpdate = vi.fn();
    render(
      <ProductDetailDialog
        open
        onOpenChange={vi.fn()}
        categories={[CATEGORY]}
        modifiers={[]}
        brands={[]}
        products={[PRODUCT]}
        suppliers={[]}
        initialProduct={PRODUCT}
        onSubmitCreate={vi.fn()}
        onSubmitUpdate={onSubmitUpdate}
      />
    );

    const comboCheckbox = screen.getByLabelText(/combo eligible/i);
    expect(comboCheckbox).toBeChecked();
    await userEvent.click(comboCheckbox);
    expect(comboCheckbox).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: /save product/i }));

    await waitFor(() => {
      expect(onSubmitUpdate).toHaveBeenCalledTimes(1);
    });
    expect(onSubmitUpdate.mock.calls[0]?.[0]).toMatchObject({ comboEligible: false });
  });
});
