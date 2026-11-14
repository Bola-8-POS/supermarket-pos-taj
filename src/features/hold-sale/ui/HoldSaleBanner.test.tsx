/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { CartItem, Product } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { HoldSaleBanner } from './HoldSaleBanner';

const PRODUCT = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Basmati rice 1kg',
  basePrice: 9,
} as Product;
const HELD: CartItem[] = [
  { tempId: 'held-1', product: PRODUCT, quantity: 1, selectedModifiers: [], unitPrice: 9, notes: '', lineTotal: 9 },
];

beforeEach(() => {
  useCartStore.setState({ items: [], heldCart: HELD, reRing: null });
});

describe('HoldSaleBanner', () => {
  it('resumes the held sale', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HoldSaleBanner />);
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(useCartStore.getState().heldCart).toBeNull();
    expect(useCartStore.getState().items).toHaveLength(1);
  });

  it('a re-ring cart cannot resume the held sale, and says why', async () => {
    const user = userEvent.setup();
    useCartStore.setState({
      reRing: {
        saleId: '11111111-1111-4111-8111-111111111111',
        approvedBy: '77777777-7777-4777-8777-777777777777',
        approvalId: 'approval-1',
        paidTotal: 18,
      },
    });
    renderWithProviders(<HoldSaleBanner />);

    const resume = screen.getByRole('button', { name: 'Resume' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAccessibleDescription(/re-ring is in the cart/i);
    expect(screen.getByText(/re-ring is in the cart/i)).toBeVisible();
    await user.click(resume);
    expect(useCartStore.getState().heldCart).toHaveLength(1);
  });
});
