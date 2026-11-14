import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewReply } from '@shared/lib/local-assistant/presenter';
import { renderWithProviders } from '@shared/lib/test-utils';
import { PreviewCard, type PinDialogProps } from './PreviewCard';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const reply = (n: number, expiresInSeconds: number): PreviewReply => ({
  type: 'preview',
  kind: 'inventory.adjust',
  proposalId: uuid(999),
  payloadHash: 'h',
  expiresInSeconds,
  items: Array.from({ length: n }, (_v, i) => ({ product_id: uuid(i + 1), name: `Item ${i + 1}`, before: 10 + i, after: 5 + i })),
});

const T0 = Date.parse('2026-11-08T12:00:00Z');
const IN_2_MIN = 120;

function setup(r: PreviewReply, now: () => number, busy = false) {
  const pin = vi.fn<(p: PinDialogProps) => null>(() => null);
  const onApprove = vi.fn();
  const onCancel = vi.fn();
  renderWithProviders(
    <PreviewCard reply={r} busy={busy} renderPinDialog={pin} onApprove={onApprove} onCancel={onCancel} now={now} />
  );
  return { pin, onApprove, onCancel };
}

describe('PreviewCard', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: false }); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders all 25 items of a full batch, each with its name, before and after', () => {
    setup(reply(25, IN_2_MIN), () => T0);
    const rows = screen.getAllByTestId('assistant-preview-row');
    expect(rows).toHaveLength(25);
    expect(rows[0]).toHaveTextContent('Item 1: 10 -> 5');
    expect(rows[24]).toHaveTextContent('Item 25: 34 -> 29');
    expect(screen.getByTestId('assistant-countdown')).toHaveTextContent('120s left');
  });

  it('a price preview shows money rows, says prices are applied one by one, and asks the PIN for manage_products', async () => {
    vi.useRealTimers();
    const price: PreviewReply = {
      ...reply(1, IN_2_MIN),
      kind: 'product.price',
      items: [{ product_id: uuid(1), name: 'Ghee', before: 12.5, after: 89.5 }],
    };
    const { pin } = setup(price, () => T0);
    expect(screen.getByTestId('assistant-preview-row')).toHaveTextContent(/Ghee: .*12\.50.* -> .*89\.50/);
    expect(screen.getByTestId('assistant-one-by-one')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('assistant-confirm'));
    expect(pin.mock.lastCall?.[0].requiredAction).toBe('manage_products');
  });

  it('opens the injected PIN dialog for adjust_inventory and approves with the matched staff id and ticket', async () => {
    vi.useRealTimers();
    const { pin, onApprove } = setup(reply(2, IN_2_MIN), () => T0);
    await userEvent.click(screen.getByTestId('assistant-confirm'));
    const last = pin.mock.lastCall?.[0];
    expect(last?.open).toBe(true);
    expect(last?.requiredAction).toBe('adjust_inventory');
    expect(last?.description).toBe('Approve the stock change for 2 products');
    act(() => { last?.onSuccess({ id: 'manager-1' }, 'ticket-1'); });
    expect(onApprove).toHaveBeenCalledWith('manager-1', 'ticket-1');
  });

  it('Cancel reports the user cancel once', async () => {
    vi.useRealTimers();
    const { onCancel } = setup(reply(1, IN_2_MIN), () => T0);
    await userEvent.click(screen.getByTestId('assistant-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('user');
  });

  it('at zero seconds disables Confirm and reports expiry exactly once', () => {
    let now = T0;
    const { onCancel } = setup(reply(1, IN_2_MIN), () => now);
    expect(screen.getByTestId('assistant-confirm')).toBeEnabled();
    now = T0 + IN_2_MIN * 1000;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('assistant-countdown')).toHaveTextContent('0s left');
    expect(screen.getByTestId('assistant-confirm')).toBeDisabled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('expired');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['fast', '2031-01-01T00:00:00Z'],
    ['slow', '2020-01-01T00:00:00Z'],
  ])('WR-02: counts down from the server TTL, so a %s till clock does not matter', (_name, tillTime) => {
    let now = Date.parse(tillTime);
    const { onCancel } = setup(reply(1, IN_2_MIN), () => now);
    expect(screen.getByTestId('assistant-countdown')).toHaveTextContent('120s left');
    expect(screen.getByTestId('assistant-confirm')).toBeEnabled();
    now += 30_000;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('assistant-countdown')).toHaveTextContent('90s left');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('WR-01: never auto-cancels on expiry while an approval is in flight (busy)', () => {
    let now = T0;
    const { onCancel } = setup(reply(1, IN_2_MIN), () => now, true);
    now = T0 + IN_2_MIN * 1000;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('assistant-countdown')).toHaveTextContent('0s left');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
