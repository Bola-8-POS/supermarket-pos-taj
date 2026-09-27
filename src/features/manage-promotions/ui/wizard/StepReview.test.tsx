import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@shared/lib/i18n';
import { vi } from 'vitest';
import type { ComboPricingDraft, SlotDraft } from '../../model/usePromotionWizardState';

// Full mock (no vi.importActual): the real @entities/promotion module imports
// the Supabase client at load time, which would break jsdom.
// evaluateBestPromotion/evaluateCombos/isProductComboEligible/getCategoryChain
// are re-exported from the pure pricing modules instead.
vi.mock('@entities/promotion', async () => {
  const pricing = await import('@entities/promotion/model/promotion-pricing');
  const combo = await import('@entities/promotion/model/combo-pricing');
  return {
    evaluateBestPromotion: pricing.evaluateBestPromotion,
    evaluateCombos: combo.evaluateCombos,
    isProductComboEligible: combo.isProductComboEligible,
    getCategoryChain: combo.getCategoryChain,
  };
});

const PRODUCT = {
  id: 'p1',
  name: 'Parle-G',
  categoryId: 'child-cat',
  basePrice: 100,
  happyHourPrice: null,
  sku: null,
  isActive: true,
  soldByWeight: false,
  imageUrl: null,
  stock_threshold: null,
  barcode: null,
  unitsPerPackage: null,
  parentProductId: null,
  comboEligible: true,
  isCombo: false,
  modifiers: [],
};

vi.mock('@entities/product', () => ({
  useProducts: () => ({ data: [PRODUCT] }),
}));
vi.mock('@entities/category', () => ({
  useCategories: () => ({
    data: [
      { id: 'parent-cat', name: 'Snacks', parentId: null, comboEligible: true },
      { id: 'child-cat', name: 'Biscuits', parentId: 'parent-cat', comboEligible: true },
    ],
  }),
}));
vi.mock('@entities/settings', () => ({
  useSettings: () => ({
    data: {
      nearExpiry: { discountPercent: 0, thresholdDays: 14 },
      general: { timezone: 'America/Mexico_City' },
    },
  }),
}));

const { StepReview } = await import('./StepReview');

function makeSlot(overrides: Partial<SlotDraft> = {}): SlotDraft {
  return { key: 's1', quantity: 1, label: '', productIds: ['p1'], categoryIds: [], ...overrides };
}

const BASE_PROPS = {
  name: 'Snack Combo',
  kind: 'combo' as const,
  discountType: 'bundle_price' as const,
  discountValue: 0,
  discountPercentStr: '0',
  storeWide: true,
  selectedProductIds: [],
  selectedCategoryIds: [],
  recurring: false,
  daysOfWeek: null,
  startTime: null,
  endTime: null,
};

function comboPricing(overrides: Partial<ComboPricingDraft> = {}): ComboPricingDraft {
  return { type: 'bundle_price', value: '50', ...overrides };
}

describe('StepReview — combo worked example (Task 7 fix round)', () => {
  it('shows no worked example when the combo is not currently live (future date range)', () => {
    render(
      <StepReview
        {...BASE_PROPS}
        slots={[makeSlot()]}
        comboPricing={comboPricing()}
        fromStr="2099-01-01"
        toStr="2099-01-31"
      />
    );
    expect(
      screen.getByText(
        /add at least one eligible product|agrega al menos un producto/i
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/example:|ejemplo:/i)).not.toBeInTheDocument();
  });

  it('shows a worked example with the discounted total for a currently-live combo', () => {
    render(
      <StepReview
        {...BASE_PROPS}
        slots={[makeSlot()]}
        comboPricing={comboPricing({ value: '50' })}
        fromStr="2020-01-01"
        toStr="2099-12-31"
      />
    );
    const example = screen.getByText(/example:|ejemplo:/i);
    expect(example.textContent).toMatch(/100\.00/);
    expect(example.textContent).toMatch(/50\.00/);
  });

  it('resolves an example product for a slot targeting a PARENT category via the ancestor chain', () => {
    // The only product is filed under child-cat, whose parent is
    // parent-cat — a slot that targets parent-cat must still resolve an
    // example product, matching evaluateCombos' own ancestor-chain rule.
    render(
      <StepReview
        {...BASE_PROPS}
        slots={[makeSlot({ productIds: [], categoryIds: ['parent-cat'] })]}
        comboPricing={comboPricing({ value: '50' })}
        fromStr="2020-01-01"
        toStr="2099-12-31"
      />
    );
    expect(screen.getByText(/example:|ejemplo:/i)).toBeInTheDocument();
  });
});
