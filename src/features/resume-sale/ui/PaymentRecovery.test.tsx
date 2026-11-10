import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@shared/lib/i18n';
import type { RecoveryView } from '../model/submissionRecovery';
import { PaymentRecovery } from './PaymentRecovery';

const SECRET_KEY = 'direct_sale_1730000000000_secretkeytext';
const base = { checking: false, onRetry: vi.fn(), onContinue: vi.fn(), items: [], totalCents: 0, draft: null };
const views: RecoveryView[] = [
  { kind: 'checking' },
  { kind: 'reconciling' },
  { kind: 'incomplete' },
  { kind: 'unknown' },
];

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en-US');
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en-US');
});

describe('PaymentRecovery', () => {
  it('unknown shows Retry Status Check as the only action', () => {
    render(<PaymentRecovery {...base} view={{ kind: 'unknown' }} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('Retry Status Check');
    expect(screen.queryByText(/discard|pay\b/i)).toBeNull();
  });

  it('double click on Retry Status Check calls onRetry once', async () => {
    const onRetry = vi.fn();
    // parent flips checking on the first call, as the real hook does
    function Harness() {
      const [checking, setChecking] = useState(false);
      return (
        <PaymentRecovery
          {...base}
          view={{ kind: 'unknown' }}
          checking={checking}
          onRetry={() => {
            onRetry();
            setChecking(true);
          }}
        />
      );
    }
    render(<Harness />);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Retry Status Check' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  });

  it('reconciling announces status through aria-live', () => {
    render(<PaymentRecovery {...base} view={{ kind: 'reconciling' }} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Please wait');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('incomplete Continue calls onContinue once', async () => {
    const onContinue = vi.fn();
    render(<PaymentRecovery {...base} view={{ kind: 'incomplete' }} onContinue={onContinue} />);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('Escape does not dismiss', async () => {
    render(<PaymentRecovery {...base} view={{ kind: 'unknown' }} />);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('payment-recovery')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

  it('es-MX copy renders for every view', async () => {
    await act(async () => {
      await i18n.changeLanguage('es-MX');
    });
    for (const view of views) {
      const { unmount } = render(<PaymentRecovery {...base} view={view} />);
      const text = screen.getByTestId('payment-recovery').textContent ?? '';
      expect(text).not.toContain('paymentRecovery.');
      expect(text).not.toMatch(/Checking payment|Payment not completed|Retry Status/);
      unmount();
    }
  });

  it('no idempotency key text in rendered output or accessible names', () => {
    for (const view of views) {
      const { container, unmount } = render(<PaymentRecovery {...base} view={view} />);
      // the key is never a prop; assert nothing key-shaped can surface either
      expect(container.ownerDocument.body.innerHTML).not.toContain(SECRET_KEY);
      expect(container.ownerDocument.body.innerHTML).not.toMatch(/direct_sale_\d+/);
      unmount();
    }
  });
});
