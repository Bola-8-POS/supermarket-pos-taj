/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Promotion } from '@entities/promotion';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { Product } from '@shared/lib/domain';
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), info: vi.fn() } }));

import { PAGE_LOADED_AT } from '@shared/lib/page-loaded-at';
import { useRehydrateReconcile } from './useRehydrateReconcile';

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const product = {
  id: PID,
  name: 'Rice',
  categoryId: '00000000-0000-4000-8000-000000000001',
  basePrice: 12,
} as Product;
const settings = {
  nearExpiry: { discountPercent: 30, thresholdDays: 7 },
  general: { timezone: 'UTC' },
};

function promo(id: string, discountType: 'percent' | 'fixed', discountValue: number): Promotion {
  return {
    id,
    name: id,
    targets: [{ id: `t-${id}`, promotionId: id, productId: PID, categoryId: null }],
    kind: 'discount',
    discountType,
    discountValue,
    startsAt: new Date('2020-01-01T00:00:00Z'),
    endsAt: new Date('2099-01-01T00:00:00Z'),
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    needsReview: false,
    active: true,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
  } as unknown as Promotion;
}

const fresh = <T>(data: T) => ({ data, dataUpdatedAt: Date.now() + 1000, isFetching: false });
const items = () => useCartStore.getState().items;
type Args = Parameters<typeof useRehydrateReconcile>[0];
const args = (over: Partial<Args> = {}): Args => ({
  isOnline: true,
  promotions: fresh([promo('p1', 'percent', 20)]),
  nearExpiry: fresh([]),
  settings,
  ...over,
});
/** A cart as restored from storage: one line stamped with promotion p1 at 9.60. */
function seedLine(p = 'p1', price = 9.6) {
  useCartStore.getState().addItem(product, [], price, p);
}

describe('useRehydrateReconcile', () => {
  beforeEach(() => {
    useCartStore.setState({ items: [] });
    vi.clearAllMocks();
  });

  describe('cashier notice (PROMO-08)', () => {
    it('one warning toast naming product, old and new price when the price went up', () => {
      seedLine();
      renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([]) })); });
      expect(toast.warning).toHaveBeenCalledTimes(1);
      expect(toast.warning).toHaveBeenCalledWith('Prices updated: Rice $9.60 -> $12.00');
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('info toast when the price went down', () => {
      seedLine();
      renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([promo('p1', 'percent', 50)]) })); });
      expect(toast.info).toHaveBeenCalledTimes(1);
      expect(toast.info).toHaveBeenCalledWith('Prices updated: Rice $9.60 -> $6.00');
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it('a single toast with (+N more) for several lines', () => {
      seedLine();
      // distinct lines: weighted lines never merge into the Rice line
      useCartStore.getState().addWeightedItem(product, 500, 5, 'p1');
      useCartStore.getState().addWeightedItem(product, 250, 2.5, 'p1');
      renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([]) })); });
      expect(toast.warning).toHaveBeenCalledTimes(1);
      expect(toast.warning).toHaveBeenCalledWith('Prices updated: Rice $9.60 -> $12.00 (+2 more)');
    });

    it('no toast when nothing changed', () => {
      seedLine();
      renderHook(() => { useRehydrateReconcile(args()); });
      expect(toast.warning).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('no toast offline or when data is not fresh', () => {
      seedLine();
      renderHook(() => { useRehydrateReconcile(args({ isOnline: false, promotions: fresh([]) })); });
      renderHook(() => { useRehydrateReconcile(args({ promotions: { data: [], dataUpdatedAt: 1, isFetching: false } })); });
      expect(toast.warning).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
    });
  });

  it('leaves a still-valid promotion line unchanged', () => {
    seedLine();
    const before = items()[0];
    renderHook(() => { useRehydrateReconcile(args()); });
    expect(items()[0]).toEqual(before);
  });

  it('re-prices to base when the promotion is gone', () => {
    seedLine();
    renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([]) })); });
    expect(items()[0]).toMatchObject({ unitPrice: 12, lineTotal: 12, promotionId: null });
  });

  it('re-prices a promotion edited in place (same id, new percent)', () => {
    seedLine();
    renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([promo('p1', 'percent', 50)]) })); });
    expect(items()[0]).toMatchObject({ unitPrice: 6, lineTotal: 6, promotionId: 'p1' });
  });

  it('moves to a better replacement promotion', () => {
    seedLine();
    renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([promo('p2', 'percent', 40)]) })); });
    expect(items()[0]).toMatchObject({ unitPrice: 7.2, promotionId: 'p2' });
  });

  it('takes a near-expiry price that now wins (promotionId null)', () => {
    seedLine();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    renderHook(() =>
      { useRehydrateReconcile(
        args({
          promotions: fresh([]),
          nearExpiry: fresh([{ productId: PID, expiryDate: tomorrow }]),
        })
      ); }
    );
    expect(items()[0]).toMatchObject({ unitPrice: 8.4, promotionId: null });
  });

  it('leaves a still-valid weighted fixed-per-kg line unchanged', () => {
    useCartStore.getState().addWeightedItem(product, 500, 5.25, 'p1');
    const before = items()[0];
    renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([promo('p1', 'fixed', 1.5)]) })); });
    expect(items()[0]).toEqual(before);
  });

  it('re-prices a weighted line to the rounded catalog line total', () => {
    useCartStore.getState().addWeightedItem(product, 333, 3, 'p1');
    renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([]) })); });
    expect(items()[0]).toMatchObject({ unitPrice: 12, lineTotal: 4, promotionId: null });
  });

  it('never clears or re-prices a line flagged priceConflict', () => {
    seedLine();
    useCartStore.getState().flagPriceConflict(items()[0]!.tempId);
    renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([]) })); });
    expect(items()[0]).toMatchObject({ unitPrice: 9.6, promotionId: 'p1', priceConflict: true });
  });

  it('does nothing offline', () => {
    seedLine();
    renderHook(() => { useRehydrateReconcile(args({ isOnline: false, promotions: fresh([]) })); });
    expect(items()[0]).toMatchObject({ unitPrice: 9.6, promotionId: 'p1' });
  });

  it.each([
    ['promotions not yet fetched', { promotions: { data: undefined, dataUpdatedAt: 0, isFetching: true } }],
    ['promotions data predates page load (cache restore)', { promotions: { data: [], dataUpdatedAt: 1, isFetching: false } }],
    ['promotions still fetching', { promotions: { data: [], dataUpdatedAt: Date.now() + 1000, isFetching: true } }],
    ['near-expiry data missing (error result)', { nearExpiry: { data: undefined, dataUpdatedAt: Date.now() + 1000, isFetching: false } }],
    ['near-expiry predates page load', { nearExpiry: { data: [], dataUpdatedAt: 1, isFetching: false } }],
  ] as const)('does nothing while %s', (_n, over) => {
    seedLine();
    renderHook(() => { useRehydrateReconcile(args(over as Partial<Args>)); });
    expect(items()[0]).toMatchObject({ unitPrice: 9.6, promotionId: 'p1' });
  });

  it('reconciles once the data lands, then never again (once per mount)', () => {
    seedLine();
    const { rerender } = renderHook((a: Args) => { useRehydrateReconcile(a); }, {
      initialProps: args({ promotions: { data: undefined, dataUpdatedAt: 0, isFetching: true } }),
    });
    expect(items()[0]).toMatchObject({ unitPrice: 9.6 });
    rerender(args({ promotions: fresh([]) }));
    expect(items()[0]).toMatchObject({ unitPrice: 12, promotionId: null });
    // a later refetch flips the promotion back on: the line is not reconciled a second time
    useCartStore.getState().resolveConflict(items()[0]!.tempId, 9.6, 'p1');
    rerender(args({ promotions: fresh([]) }));
    expect(items()[0]).toMatchObject({ unitPrice: 9.6, promotionId: 'p1' });
  });

  it('ignores lines added after mount', () => {
    renderHook(() => { useRehydrateReconcile(args({ promotions: fresh([]) })); });
    seedLine(); // added after the snapshot
    expect(items()[0]).toMatchObject({ unitPrice: 9.6, promotionId: 'p1' });
  });

  describe('freshness is anchored to page load, not hook mount', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('reconciles data fetched after page load but BEFORE the hook mounted (app-level warmer)', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(PAGE_LOADED_AT + 50); // hook mounts 50ms after the warmer fetched
      seedLine();
      renderHook(() => {
        useRehydrateReconcile(args({
          promotions: { data: [], dataUpdatedAt: PAGE_LOADED_AT + 20, isFetching: false },
          nearExpiry: { data: [], dataUpdatedAt: PAGE_LOADED_AT + 19, isFetching: false },
        }));
      });
      expect(items()[0]).toMatchObject({ unitPrice: 12, promotionId: null });
    });

    it('does not reconcile data restored from the persisted cache (stamped before page load)', () => {
      seedLine();
      renderHook(() => {
        useRehydrateReconcile(args({
          promotions: { data: [], dataUpdatedAt: PAGE_LOADED_AT - 1, isFetching: false },
        }));
      });
      expect(items()[0]).toMatchObject({ unitPrice: 9.6, promotionId: 'p1' });
    });

    it('does not reconcile while a refetch is in flight', () => {
      seedLine();
      renderHook(() => {
        useRehydrateReconcile(args({
          nearExpiry: { data: [], dataUpdatedAt: PAGE_LOADED_AT + 1, isFetching: true },
        }));
      });
      expect(items()[0]).toMatchObject({ unitPrice: 9.6, promotionId: 'p1' });
    });
  });
});
