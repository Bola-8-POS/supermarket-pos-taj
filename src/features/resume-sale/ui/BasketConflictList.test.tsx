import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@shared/lib/i18n';
import type { BasketConflict } from '../model/basketConflicts';
import { BasketConflictList } from './BasketConflictList';

const price: BasketConflict = {
  key: 'l1:price:1350',
  lineId: 'l1',
  productName: 'Basmati Rice',
  kind: 'price',
  saved: 1250,
  current: 1350,
};
const stock: BasketConflict = {
  key: 'l2:stock:1',
  lineId: 'l2',
  productName: 'Loose Dal',
  kind: 'stock',
  saved: 3,
  current: 1,
};
const gone: BasketConflict = {
  key: 'l3:unavailable',
  lineId: 'l3',
  productName: 'Old Ghee',
  kind: 'unavailable',
  saved: null,
  current: null,
};

function renderList(over: Partial<React.ComponentProps<typeof BasketConflictList>> = {}) {
  const onAccept = vi.fn();
  const onRemoveLine = vi.fn();
  const view = render(
    <BasketConflictList
      conflicts={[price, stock, gone]}
      acceptedKeys={new Set()}
      onAccept={onAccept}
      onRemoveLine={onRemoveLine}
      {...over}
    />
  );
  return { onAccept, onRemoveLine, ...view };
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en-US');
});

describe('BasketConflictList', () => {
  it('each row shows product, kind, saved and current values', () => {
    renderList();
    const rows = screen.getAllByTestId('basket-conflict');
    expect(rows).toHaveLength(3);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('Basmati Rice')).toBeInTheDocument();
    expect(first.getByText('Price changed')).toBeInTheDocument();
    expect(first.getByTestId('conflict-saved')).toHaveTextContent('$12.50');
    expect(first.getByTestId('conflict-current')).toHaveTextContent('$13.50');
    const second = within(rows[1] as HTMLElement);
    expect(second.getByTestId('conflict-saved')).toHaveTextContent('3');
    expect(second.getByTestId('conflict-current')).toHaveTextContent('1');
    const third = within(rows[2] as HTMLElement);
    expect(third.getByTestId('conflict-current')).toHaveTextContent(
      'Product unavailable — remove this item to continue.'
    );
    expect(third.queryByRole('button', { name: 'Accept Current Values' })).toBeNull();
  });

  it('Accept marks only that row accepted', async () => {
    const { onAccept } = renderList({ acceptedKeys: new Set([stock.key]) });
    const user = userEvent.setup();
    const rows = screen.getAllByTestId('basket-conflict');
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Accept Current Values' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith(price.key);
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Accepted' })).toBeDisabled();
  });

  it('Remove line calls onRemoveLine with the line id', async () => {
    const { onRemoveLine } = renderList();
    const rows = screen.getAllByTestId('basket-conflict');
    await userEvent.click(within(rows[2] as HTMLElement).getByRole('button', { name: 'Remove Item' }));
    expect(onRemoveLine).toHaveBeenCalledWith('l3');
  });

  it('es-MX money formatting', async () => {
    await act(async () => {
      await i18n.changeLanguage('es-MX');
    });
    renderList({ conflicts: [price] });
    expect(screen.getByTestId('conflict-saved')).toHaveTextContent('MX$12.50');
    expect(screen.getByTestId('conflict-current')).toHaveTextContent('MX$13.50');
    expect(screen.getByRole('button', { name: 'Aceptar valores actuales' })).toBeInTheDocument();
  });
});
