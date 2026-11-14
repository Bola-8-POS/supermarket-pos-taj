import { describe, expect, it } from 'vitest';
import { numbersInText } from './number-words';
import { normalize } from './router';

describe('numbersInText shares the router number rules', () => {
  it.each([
    ['cambia el precio de aceite a 1,500', 1500],
    ['precio 12,50', 12.5],
    ['precio 1.500', 1.5], // router: a dot is always a decimal point
    ['precio 1,500.50', 1500.5],
    ['precio 1,500,000', 1500000],
  ])('%s -> %d', (text, n) => {
    expect(numbersInText(text)).toContain(n);
    expect(normalize(text)).toContain(String(n));
  });

  it('does not ground 1.5 for "1,500"', () => {
    expect(numbersInText('a 1,500')).not.toContain(1.5);
  });
});
