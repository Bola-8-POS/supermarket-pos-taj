/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@shared/lib/domain';
import { useConfirmRiskyAdd } from './useConfirmRiskyAdd';

const online = vi.hoisted(() => ({ value: true }));
vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isOnline: () => online.value,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

const PRODUCT = { id: 'p1', name: 'Basmati rice 1kg', basePrice: 9, quantityOnHand: 0 } as Product;

beforeEach(() => {
  vi.clearAllMocks();
  online.value = true;
});

describe('useConfirmRiskyAdd', () => {
  it('asks before adding a low-stock product while online', () => {
    const onConfirm = vi.fn();
    renderHook(() => useConfirmRiskyAdd()).result.current('low-stock', PRODUCT, onConfirm);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // Ruling 14: the stock figures on a cached catalog are hours old; the server arbitrates at replay.
  it('does not ask about stock offline: the cached figures are not evidence', () => {
    online.value = false;
    const onConfirm = vi.fn();
    renderHook(() => useConfirmRiskyAdd()).result.current('low-stock', PRODUCT, onConfirm);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('still asks about a zero price offline', () => {
    online.value = false;
    const onConfirm = vi.fn();
    renderHook(() => useConfirmRiskyAdd()).result.current('zero-price', PRODUCT, onConfirm);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
