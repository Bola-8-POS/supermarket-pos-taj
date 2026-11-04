/* eslint-disable import/order -- vi.mock factories must precede imports */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('@features/lookup-product-by-barcode/model/useLookupProductByBarcode', () => ({
  useLookupProductByBarcode: () => ({ lookup: mockLookup }),
}));
vi.mock('@features/open-product-peek-window/model/useProductPeekWindow', () => ({
  ADD_TO_CART_EVENT: 'add',
  BARCODE_SCANNED_EVENT: 'scanned',
  PEEK_WINDOW_REFRESH_EVENT: 'refresh',
}));
vi.mock('@features/add-loose-weight-item/ui/WeightEntryDialog', () => ({ WeightEntryDialog: () => null }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ hide: vi.fn() }) }));
const mockResolve = vi.hoisted(() => vi.fn());
vi.mock('@entities/inventory', () => ({ useNearExpiryPricingDates: () => ({ data: [] }) }));
vi.mock('@entities/promotion', () => ({
  usePromotions: () => ({ data: [] }),
  resolveProductPromotion: mockResolve,
}));
vi.mock('@entities/settings', () => ({
  useSettings: () => ({
    data: {
      nearExpiry: { discountPercent: 15, thresholdDays: 14 },
      general: { timezone: 'America/Mexico_City' },
    },
  }),
}));
vi.mock('@entities/product/model/useConfirmRiskyAdd', () => ({ useConfirmRiskyAdd: () => vi.fn() }));
vi.mock('@shared/lib/useBarcodeScanner', () => ({ useBarcodeScanner: () => undefined }));
vi.mock('@shared/lib/pos-printer', () => ({ isTauri: () => false }));
const online = vi.hoisted(() => ({ value: true }));
vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOnlineStatus: () => online.value,
}));

import { IsRestoringProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { ProductPeekWindow } from './ProductPeekWindow';

describe('ProductPeekWindow lookup outcomes', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/?window=peek&barcode=0000000000000');
    mockLookup.mockReset();
    mockResolve.mockReset();
    mockResolve.mockReturnValue(null);
    online.value = true;
  });

  // Ruling 14: the stock figures in the cached catalog are hours old; offline the till shows none.
  it('stock figures are not shown offline', async () => {
    const product = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Basmati rice 1kg',
      categoryId: '66666666-6666-4666-8666-666666666666',
      basePrice: 9,
      soldByWeight: false,
      sku: null,
      barcode: '0000000000000',
      quantityOnHand: 3,
      lowStockThreshold: 5,
      modifiers: [],
    };
    mockLookup.mockResolvedValue({ ok: true, data: product });
    const view = render(<ProductPeekWindow />);
    expect(await screen.findByText(/3 in stock/i)).toBeTruthy();
    view.unmount();

    online.value = false;
    render(<ProductPeekWindow />);
    expect(await screen.findByText('Basmati rice 1kg')).toBeTruthy();
    expect(screen.queryByText(/in stock/i)).toBeNull();
    expect(screen.queryByText(/low stock|out of stock/i)).toBeNull();
  });

  describe('price preview agrees with the cart', () => {
    const base = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Loose rice',
      categoryId: '66666666-6666-4666-8666-666666666666',
      basePrice: 12,
      sku: null,
      barcode: '0000000000000',
      quantityOnHand: 3,
      lowStockThreshold: 5,
      modifiers: [],
    };
    const promo = { promotionId: 'x', discountRate: 50, discountAmount: 6, discountedUnitPrice: 6 };

    // The cart discounts a loose-weight LINE (it depends on the weight), so the peek, which does
    // not know the weight, previews the catalog per-kg price rather than a per-kg discount.
    it('a loose-weight product previews its catalog per-kg price, never a per-kg promotion price', async () => {
      mockResolve.mockReturnValue(promo);
      mockLookup.mockResolvedValue({ ok: true, data: { ...base, soldByWeight: true } });
      render(<ProductPeekWindow />);
      expect((await screen.findAllByText(/12\.00/)).length).toBeGreaterThan(0);
      expect(screen.queryByText(/6\.00/)).toBeNull();
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('a unit-priced product previews the price the shared resolver returns', async () => {
      mockResolve.mockReturnValue(promo);
      mockLookup.mockResolvedValue({ ok: true, data: { ...base, soldByWeight: false } });
      render(<ProductPeekWindow />);
      expect((await screen.findAllByText(/6\.00/)).length).toBeGreaterThan(0);
      expect(mockResolve).toHaveBeenCalled();
    });
  });

  it('tells the cashier an unknown barcode scanned offline needs connectivity, not that it does not exist', async () => {
    mockLookup.mockResolvedValue({ ok: false, error: { code: 'NETWORK_OFFLINE', message: 'offline' } });
    render(<ProductPeekWindow />);
    expect(await screen.findByText(/local catalog/i)).toBeTruthy();
    expect(screen.queryByText(/product not found/i)).toBeNull();
  });

  it('still reports a genuine online miss as not found', async () => {
    mockLookup.mockResolvedValue({ ok: true, data: null });
    render(<ProductPeekWindow />);
    expect(await screen.findByText(/product not found/i)).toBeTruthy();
  });

  it('shows the load error when the lookup fails for any other reason', async () => {
    mockLookup.mockResolvedValue({ ok: false, error: { code: 'SUPABASE_ERROR', message: 'boom' } });
    render(<ProductPeekWindow />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('waits for the persisted cache to finish restoring before looking the barcode up', async () => {
    mockLookup.mockResolvedValue({ ok: true, data: null });
    const { rerender } = render(
      <IsRestoringProvider value={true}>
        <ProductPeekWindow />
      </IsRestoringProvider>
    );
    await Promise.resolve();
    expect(mockLookup).not.toHaveBeenCalled();

    rerender(
      <IsRestoringProvider value={false}>
        <ProductPeekWindow />
      </IsRestoringProvider>
    );
    expect(await screen.findByText(/product not found/i)).toBeTruthy();
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });
});
