import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartItem, CheckoutDraft } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { ResumeSaleDialog } from './ResumeSaleDialog';

const product = (name: string, id: string, soldByWeight = false): CartItem['product'] => ({
  id,
  name,
  categoryId: '11111111-1111-1111-1111-111111111111',
  basePrice: 10,
  happyHourPrice: null,
  sku: null,
  isActive: true,
  soldByWeight,
  imageUrl: null,
  photoPath: null,
  stock_threshold: null,
  unitsPerPackage: null,
  parentProductId: null,
  brandId: null,
  weightAmount: null,
  weightUnit: null,
  comboEligible: true,
  isCombo: false,
  modifiers: [],
});

const items: CartItem[] = [
  {
    tempId: 'line-1',
    product: product('Basmati Rice', 'ffffffff-ffff-ffff-ffff-fffffffffff1'),
    quantity: 3,
    selectedModifiers: [],
    unitPrice: 12.5,
    notes: '',
    lineTotal: 37.5,
  },
  {
    tempId: 'line-2',
    product: product('Loose Dal', 'ffffffff-ffff-ffff-ffff-fffffffffff2', true),
    quantity: 1,
    weightGrams: 1250,
    selectedModifiers: [],
    unitPrice: 8,
    notes: '',
    lineTotal: 10,
  },
];

const draft: CheckoutDraft = {
  method: 'cash',
  tenderedCents: 6000,
  splitLegs: [],
  discount: { type: 'percent', value: 10 },
  reference: null,
};

function renderDialog(over: Partial<React.ComponentProps<typeof ResumeSaleDialog>> = {}) {
  const onResume = vi.fn();
  const onDiscard = vi.fn();
  render(
    <ResumeSaleDialog
      open
      items={items}
      totalCents={4750}
      draft={draft}
      onResume={onResume}
      onDiscard={onDiscard}
      {...over}
    />
  );
  return { onResume, onDiscard };
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en-US');
});

describe('ResumeSaleDialog', () => {
  it('Resume Sale has initial focus', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Resume Sale' })).toHaveFocus();
  });

  it('Escape does nothing', async () => {
    const { onResume, onDiscard } = renderDialog();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(onResume).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('outside click does nothing', () => {
    const { onResume, onDiscard } = renderDialog();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(onResume).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('no close control is rendered', () => {
    renderDialog();
    const buttons = within(screen.getByRole('alertdialog')).getAllByRole('button');
    expect(buttons.map(b => b.textContent)).toEqual(['Resume Sale', 'Discard Checkout']);
  });

  it('Resume calls onResume once on double click', async () => {
    const { onResume } = renderDialog();
    const user = userEvent.setup();
    await user.dblClick(screen.getByRole('button', { name: 'Resume Sale' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('Discard calls onDiscard once', async () => {
    const { onDiscard, onResume } = renderDialog();
    const user = userEvent.setup();
    await user.dblClick(screen.getByRole('button', { name: 'Discard Checkout' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('every cart line renders product, quantity, saved unit price and line total', () => {
    renderDialog();
    const rows = screen.getAllByTestId('resume-line');
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('Basmati Rice')).toBeInTheDocument();
    expect(first.getByTestId('resume-line-quantity')).toHaveTextContent('3');
    expect(first.getByTestId('resume-line-unit-price')).toHaveTextContent('$12.50');
    expect(first.getByTestId('resume-line-total')).toHaveTextContent('$37.50');
  });

  it('a weighed line renders its weight through the cart formatter', () => {
    renderDialog();
    const row = within(screen.getAllByTestId('resume-line')[1] as HTMLElement);
    expect(row.getByTestId('resume-line-quantity')).toHaveTextContent('Weight: 1.250 kg');
  });

  it('restored values render in order with es-MX formatting', async () => {
    await act(async () => {
      await i18n.changeLanguage('es-MX');
    });
    renderDialog();
    const rows = screen.getAllByTestId('resume-line');
    expect(rows.map(r => within(r).getByTestId('resume-line-total').textContent)).toEqual(['MX$37.50', 'MX$10.00']);
    expect(screen.getByTestId('resume-total')).toHaveTextContent('MX$47.50');
    expect(screen.getByTestId('resume-tendered')).toHaveTextContent('MX$60.00');
    expect(screen.getByRole('button', { name: 'Reanudar venta' })).toBeInTheDocument();
  });

  it('shows split legs in order, and a reference only when present', () => {
    renderDialog({
      draft: {
        method: 'card',
        tenderedCents: 0,
        splitLegs: [
          { method: 'card', amountCents: 1000 },
          { method: 'cash', amountCents: 3750 },
        ],
        discount: null,
        reference: 'AB1234',
      },
    });
    const legs = screen.getAllByTestId('resume-split-leg');
    expect(legs[0]).toHaveTextContent('Card');
    expect(legs[0]).toHaveTextContent('$10.00');
    expect(legs[1]).toHaveTextContent('Cash');
    expect(screen.getByTestId('resume-reference')).toHaveTextContent('AB1234');
    cleanup();
    renderDialog({ draft: { ...draft, reference: null } });
    expect(screen.queryByTestId('resume-reference')).not.toBeInTheDocument();
  });

  it('no idempotency key text in rendered output or accessible names', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).not.toMatch(/idempotency|key/i);
    expect(dialog.innerHTML).not.toMatch(/idempotency/i);
  });

  it('basket total and saved payment details render with no PIN, approval, key or marker field', () => {
    renderDialog();
    expect(screen.getByTestId('resume-total')).toHaveTextContent('$47.50');
    expect(screen.getByTestId('resume-discount')).toHaveTextContent('10%');
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).not.toMatch(/pin|approval|manager|marker|submission/i);
    expect(dialog.querySelectorAll('input')).toHaveLength(0);
  });
});
