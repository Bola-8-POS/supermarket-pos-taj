import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { AmountKeypad } from './AmountKeypad';

function noop() {
  /* no-op */
}

describe('AmountKeypad', () => {
  test('renders the 10 digit buttons by accessible name', () => {
    render(<AmountKeypad value={0} onChange={noop} disabled={false} />);
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(screen.getByRole('button', { name: d })).toBeInTheDocument();
    }
  });

  test('renders clear/backspace buttons by their i18n accessible name', () => {
    render(<AmountKeypad value={0} onChange={noop} disabled={false} />);
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Backspace' })).toBeInTheDocument();
  });

  test('display shows the formatted amount', () => {
    render(<AmountKeypad value={12.5} onChange={noop} disabled={false} />);
    expect(screen.getByTestId('amount-keypad-display')).toHaveTextContent('12.50');
  });

  test('pressing digits shifts them in as cents, rightmost first', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AmountKeypad value={1.25} onChange={onChange} disabled={false} />);
    await user.click(screen.getByRole('button', { name: '7' }));
    // 1.25 -> 125 cents -> *10+7 = 1257 cents -> 12.57
    expect(onChange).toHaveBeenCalledWith(12.57);
  });

  test('backspace drops the rightmost cent', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AmountKeypad value={12.57} onChange={onChange} disabled={false} />);
    await user.click(screen.getByRole('button', { name: 'Backspace' }));
    expect(onChange).toHaveBeenCalledWith(1.25);
  });

  test('clear resets to zero', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AmountKeypad value={42.5} onChange={onChange} disabled={false} />);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith(0);
  });

  test('a digit press that would exceed the cap is ignored', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AmountKeypad value={999_999.99} onChange={onChange} disabled={false} />);
    await user.click(screen.getByRole('button', { name: '9' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('disabled=true disables every button', () => {
    render(<AmountKeypad value={0} onChange={noop} disabled={true} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
  });

  test('every button has type="button" (no implicit form submit)', () => {
    render(<AmountKeypad value={0} onChange={noop} disabled={false} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAttribute('type', 'button');
    }
  });

  test('the section carries the data-testid and an aria-label from i18n', () => {
    render(<AmountKeypad value={0} onChange={noop} disabled={false} />);
    const section = screen.getByTestId('amount-keypad');
    expect(section).toHaveAttribute('aria-label', 'Amount keypad');
  });
});
