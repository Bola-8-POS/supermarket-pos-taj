import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PendingBatch } from '@shared/lib/local-assistant/presenter';
import { renderWithProviders } from '@shared/lib/test-utils';
import { ChoiceCard } from './ChoiceCard';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const product = (i: number, name: string, qty: number) => ({
  productId: uuid(i),
  name,
  price: 5,
  quantityOnHand: qty,
  barcode: null,
});

const pending: PendingBatch = {
  kind: 'inventory.adjust',
  reason: 'waste',
  userText: 'write off milk and rice',
  items: [
    { delta: -1, label: 'milk', candidates: [product(1, 'Milk 1L', 4), product(2, 'Milk 500ml', 9)], chosenId: null },
    { delta: -2, label: null, candidates: [product(3, 'Rice 1kg', 7)], chosenId: uuid(3) },
    { delta: -1, label: null, candidates: [product(4, 'Soap A', 1), product(5, 'Soap B', 2)], chosenId: null },
  ],
};

describe('ChoiceCard', () => {
  it('lists the candidates of every unresolved item only, labelling an item by the staff words or its position', () => {
    renderWithProviders(<ChoiceCard pending={pending} busy={false} onChoose={vi.fn()} />);
    const groups = screen.getAllByTestId('assistant-choice-item');
    expect(groups).toHaveLength(2);
    expect(within(groups[0]!).getByText('Which one is "milk"?')).toBeInTheDocument();
    expect(within(groups[0]!).getAllByTestId('assistant-product-choice').map(b => b.textContent)).toEqual([
      'Milk 1L (4 in stock)',
      'Milk 500ml (9 in stock)',
    ]);
    expect(within(groups[1]!).getByText('Item 3: which product?')).toBeInTheDocument();
    expect(screen.queryByText(/Rice 1kg/)).not.toBeInTheDocument();
  });

  it('reports the item index and the product id of the tapped candidate', async () => {
    const onChoose = vi.fn();
    renderWithProviders(<ChoiceCard pending={pending} busy={false} onChoose={onChoose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Soap B (2 in stock)' }));
    expect(onChoose).toHaveBeenCalledWith(2, uuid(5));
  });

  it('disables every option while a call is in flight', () => {
    renderWithProviders(<ChoiceCard pending={pending} busy onChoose={vi.fn()} />);
    for (const b of screen.getAllByTestId('assistant-product-choice')) expect(b).toBeDisabled();
  });
});
