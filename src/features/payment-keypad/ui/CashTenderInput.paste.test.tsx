import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { beforeEach, describe, expect, test } from 'vitest';
import i18n from '@shared/lib/i18n';
import { reduceCashTender, type CashTenderState } from '../model/cashTenderBuffer';
import { CashTenderInput } from './CashTenderInput';

const EMPTY: CashTenderState = { text: '', armed: false };

function Harness({ initial = EMPTY }: { initial?: CashTenderState }) {
  const [state, dispatch] = useReducer(reduceCashTender, initial);
  return (
    <CashTenderInput id="cash" label="Amount tendered" state={state} onAction={dispatch} disabled={false} keypadVisible />
  );
}
const field = () => screen.getByLabelText<HTMLInputElement>('Amount tendered');

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
});

/** Review M2: a paste REPLACES the tender whatever the caret position or the displayed value. */
describe('CashTenderInput paste (30-review M2)', () => {
  test.each([
    ['caret at start', 0],
    ['caret at end', 4],
  ])('pasting "150" over 0.00 with %s gives 150.00', async (_n, caret) => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(field());
    field().setSelectionRange(caret, caret);
    await user.paste('150');
    expect(field().value).toBe('150.00');
  });

  test('pasting over an existing amount replaces it', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ text: '4500', armed: false }} />);
    await user.click(field());
    field().setSelectionRange(0, 0);
    await user.paste('150');
    expect(field().value).toBe('150.00');
  });

  test('pasted decimal text is replayed through the reducer', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(field());
    await user.paste('12.5');
    expect(field().value).toBe('12.50');
  });
});
