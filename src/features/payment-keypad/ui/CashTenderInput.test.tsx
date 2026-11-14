import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useReducer } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import i18n from '@shared/lib/i18n';
import {
  cashTenderCents,
  reduceCashTender,
  type CashTenderAction,
  type CashTenderState,
} from '../model/cashTenderBuffer';
import { CashTenderInput } from './CashTenderInput';

const EMPTY: CashTenderState = { text: '', armed: false };

let dispatchRef: (a: CashTenderAction) => void = () => {
  /* set by Harness */
};
let stateRef: CashTenderState = EMPTY;

function Harness({
  disabled = false,
  keypadVisible = true,
  initial = EMPTY,
  onSubmit,
}: {
  disabled?: boolean;
  keypadVisible?: boolean;
  initial?: CashTenderState;
  onSubmit?: () => void;
}) {
  const [state, dispatch] = useReducer(reduceCashTender, initial);
  useEffect(() => {
    dispatchRef = dispatch;
    stateRef = state;
  });
  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <CashTenderInput
        id="cash"
        label="Amount tendered"
        state={state}
        onAction={dispatch}
        disabled={disabled}
        keypadVisible={keypadVisible}
      />
    </form>
  );
}

const field = () => screen.getByLabelText('Amount tendered');
const key = (digit: number) => screen.getByRole('button', { name: `Key ${String(digit)}` });

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  stateRef = EMPTY;
});

describe('CashTenderInput', () => {
  test('renders keys in the 7 8 9 / 4 5 6 / 1 2 3 / Clear 0 . order with Backspace', () => {
    render(<Harness />);
    const names = screen.getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual([
      'Key 7', 'Key 8', 'Key 9', 'Key 4', 'Key 5', 'Key 6', 'Key 1', 'Key 2', 'Key 3',
      'Clear', 'Key 0', 'Decimal point', 'Backspace',
    ]);
  });

  test('keys are at least 56px', () => {
    render(<Harness />);
    for (const b of screen.getAllByRole('button')) {
      expect(b.className).toContain('min-h-[56px]');
      expect(b.className).toContain('min-w-[56px]');
    }
  });

  test('pointer: 1, 0, 0 shows 100.00', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(key(1));
    await user.click(key(0));
    await user.click(key(0));
    expect(field()).toHaveValue('100.00');
  });

  test('pointer: decimal, clear and backspace', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(key(1));
    await user.click(screen.getByRole('button', { name: 'Decimal point' }));
    await user.click(key(5));
    expect(field()).toHaveValue('1.50');
    await user.click(screen.getByRole('button', { name: 'Backspace' }));
    expect(field()).toHaveValue('1.00');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(field()).toHaveValue('0.00');
  });

  test('top-row and numpad digits, decimal, Backspace and Delete are handled', () => {
    render(<Harness />);
    const f = field();
    fireEvent.keyDown(f, { key: '1', code: 'Digit1' });
    fireEvent.keyDown(f, { key: '2', code: 'Numpad2' });
    fireEvent.keyDown(f, { key: ',', code: 'NumpadDecimal' });
    fireEvent.keyDown(f, { key: '5', code: 'Numpad5' });
    expect(f).toHaveValue('12.50');
    fireEvent.keyDown(f, { key: 'Backspace' });
    expect(f).toHaveValue('12.00');
    fireEvent.keyDown(f, { key: '.', code: 'Period' });
    expect(f).toHaveValue('12.00');
    fireEvent.keyDown(f, { key: 'Delete' });
    expect(f).toHaveValue('0.00');
  });

  test('pointer and keyboard sequences yield identical state', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(key(4));
    await user.click(screen.getByRole('button', { name: 'Decimal point' }));
    await user.click(key(7));
    await user.click(key(5));
    await user.click(key(9));
    await user.click(screen.getByRole('button', { name: 'Backspace' }));
    const pointerState = stateRef;
    unmount();

    render(<Harness />);
    const f = field();
    for (const k of ['4', '.', '7', '5', '9', 'Backspace']) fireEvent.keyDown(f, { key: k });
    expect(stateRef).toEqual(pointerState);
    expect(cashTenderCents(stateRef)).toBe(470); // 4.75, third fraction digit ignored, backspace -> 4.7
  });

  test('Enter does not submit the enclosing form', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    field().focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('processing ignores keys and disables buttons', () => {
    render(<Harness disabled />);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    fireEvent.keyDown(field(), { key: '5' });
    expect(field()).toHaveValue('0.00');
    expect(stateRef).toEqual(EMPTY);
  });

  test('es-MX labels exist for every key', async () => {
    await i18n.changeLanguage('es-MX');
    render(<Harness />);
    const names = screen.getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual([
      'Tecla 7', 'Tecla 8', 'Tecla 9', 'Tecla 4', 'Tecla 5', 'Tecla 6', 'Tecla 1', 'Tecla 2', 'Tecla 3',
      'Borrar', 'Tecla 0', 'Punto decimal', 'Retroceso',
    ]);
    expect(screen.getByRole('group', { name: 'Entrada de monto en efectivo' })).toBeInTheDocument();
  });

  test.each([
    ['en-US', '$'],
    ['es-MX', 'MX$'],
  ])('%s displays 1234.50 with the locale currency symbol', async (locale, symbol) => {
    await i18n.changeLanguage(locale);
    render(<Harness initial={{ text: '1234.5', armed: false }} />);
    expect(screen.getByRole('textbox')).toHaveValue('1234.50');
    expect(screen.getByText(symbol)).toBeInTheDocument();
  });

  test('preset while focused updates the display', () => {
    render(<Harness />);
    field().focus();
    act(() => {
      dispatchRef({ type: 'preset', cents: 50000 });
    });
    expect(field()).toHaveValue('500.00');
    fireEvent.keyDown(field(), { key: '7' });
    expect(field()).toHaveValue('7.00');
  });

  test('keydown on document.body changes nothing', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: '5' });
    expect(field()).toHaveValue('0.00');
  });

  test('paste and fill are replayed through the reducer (sanitised, capped)', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: '100' } });
    expect(field()).toHaveValue('100.00');
    fireEvent.change(field(), { target: { value: 'MX$1,234.567' } });
    expect(field()).toHaveValue('1234.56');
    fireEvent.change(field(), { target: { value: '99999999' } }); // digits past MAX_CENTS are ignored
    expect(field()).toHaveValue('999999.00');
    fireEvent.change(field(), { target: { value: '' } });
    expect(field()).toHaveValue('0.00');
  });

  test('keypadVisible=false hides the keys but the field still takes the keyboard', () => {
    render(<Harness keypadVisible={false} />);
    expect(screen.queryByTestId('amount-keypad')).toBeNull();
    fireEvent.keyDown(field(), { key: '8' });
    expect(field()).toHaveValue('8.00');
  });
});
