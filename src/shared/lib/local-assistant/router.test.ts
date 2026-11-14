import { describe, expect, it } from 'vitest';
import { ground } from './grounding';
import { Proposal } from './proposal';
import { normalize, route } from './router';

// Phrases here are deliberately NOT in scripts/fixtures/assistant-accuracy*.json: the patterns are general.
const args = (text: string): unknown => {
  const p = route(text);
  return p && 'args' in p ? p.args : undefined;
};
const kind = (text: string): string | null => route(text)?.kind ?? null;

describe('normalize', () => {
  it('lowercases, strips accents and punctuation, collapses spaces', () => {
    expect(normalize('  ¿CUÁNTO   cuesta el JAMÓN?! ')).toBe('cuanto cuesta el jamon');
  });
  it('keeps decimals, fixes slang and light typos, turns number words into digits', () => {
    expect(normalize('set tea to 12,50')).toBe('set tea to 12.50');
    expect(normalize('q hay de jamon')).toBe('que hay de jamon');
    expect(normalize('pricee of tea')).toBe('price of tea');
    expect(normalize('thirty-five and treinta y cinco and twenty')).toBe('35 and 35 and 20');
  });
});

describe('product.lookup', () => {
  it('extracts the product after price/stock phrases in en and es', () => {
    expect(args('price of cheddar cheese')).toEqual({ query: 'cheddar cheese' });
    expect(args('how much is the olive oil?')).toEqual({ query: 'olive oil' });
    expect(args('do you have ginger')).toEqual({ query: 'ginger' });
    expect(args('how many bottles of vinegar are left')).toEqual({ query: 'vinegar' });
    expect(args('cuanto vale el jamon')).toEqual({ query: 'jamon' });
    expect(args('precioo de la mantequilla porfa')).toEqual({ query: 'mantequilla' });
    expect(args('hay jitomate?')).toEqual({ query: 'jitomate' });
    expect(args('existencias de la sal')).toEqual({ query: 'sal' });
  });
  it('is not a lookup when only generic words follow', () => {
    expect(kind('price of products')).toBeNull();
  });
});

describe('product.list', () => {
  it('lists with an optional limit (digits or number words) and sort', () => {
    expect(args('list 8 products')).toEqual({ query: null, limit: 8, sort: null });
    expect(args('muestrame veinte productos')).toEqual({ query: null, limit: 20, sort: null });
    expect(args('give me thirty five items')).toEqual({ query: null, limit: 35, sort: null });
    expect(args('display the newest items')).toEqual({ query: null, limit: null, sort: 'newest' });
    expect(args('show 5 articulos con menos existencias')).toEqual({ query: null, limit: 5, sort: 'stock_low' });
  });
});

describe('stock.low', () => {
  it('matches low-stock phrases and takes an optional supplier', () => {
    expect(args('items low on stock from Nestle')).toEqual({ supplierQuery: 'nestle' });
    expect(args('poco inventario de Pepsi')).toEqual({ supplierQuery: 'pepsi' });
    expect(args('what needs reorder')).toEqual({ supplierQuery: null });
    expect(args('anything out of stock')).toEqual({ supplierQuery: null });
  });
});

describe('expiry.list', () => {
  it('reads days from numbers, number words and time words', () => {
    expect(args('which items expire in 10 days')).toEqual({ withinDays: 10 });
    expect(args('productos que vencen en quince dias')).toEqual({ withinDays: 15 });
    expect(args('que caduca esta semana')).toEqual({ withinDays: 7 });
    expect(args('expiring today')).toEqual({ withinDays: 0 });
    expect(args('what is about to expire')).toEqual({ withinDays: null });
  });
});

describe('sales.summary and sales.recent', () => {
  it('routes summaries', () => {
    expect(kind('how much money did we make today')).toBe('sales.summary');
    expect(kind('reporte de ventas del dia')).toBe('sales.summary');
    expect(kind('end of day report')).toBe('sales.summary');
  });
  it('routes recent sales with an optional limit', () => {
    expect(args('most recent payment')).toEqual({ limit: null });
    expect(args('ultimos tres cobros')).toEqual({ limit: 3 });
    expect(args('show the last 6 orders')).toEqual({ limit: 6 });
  });
});

describe('writes still produce a proposal, never an execution', () => {
  it('write-off: negative delta, waste reason for spoiled stock', () => {
    expect(route('write off 5 spoiled tomatoes')).toEqual({
      kind: 'inventory.adjust',
      args: { reason: 'waste', items: [{ query: 'tomatoes', delta: -5 }] },
    });
    expect(args('da de baja 7 panes caducados')).toEqual({ reason: 'waste', items: [{ query: 'panes', delta: -7 }] });
    expect(args('write off 2 milk and 3 eggs')).toEqual({
      reason: 'waste',
      items: [
        { query: 'milk', delta: -2 },
        { query: 'eggs', delta: -3 },
      ],
    });
  });
  it('price change: whole cents', () => {
    expect(args('change price of tea to 15.25')).toEqual({ items: [{ query: 'tea', priceCents: 1525 }] });
    expect(args('cambia el precio de la sal a 18')).toEqual({ items: [{ query: 'sal', priceCents: 1800 }] });
    expect(args('ponle 20 pesos a la sal')).toEqual({ items: [{ query: 'sal', priceCents: 2000 }] });
  });
  it('never invents a number: no quantity or price means no proposal', () => {
    expect(kind('write off the expired milk')).toBeNull();
    expect(kind('change the price of tea')).toBeNull();
    expect(kind('update the stock')).toBeNull();
  });
});

describe('falls through to the model', () => {
  it('on no match', () => {
    expect(route('tell me a joke')).toBeNull();
    expect(route('what is the weather tomorrow')).toBeNull();
    expect(route('delete everything')).toBeNull();
  });
  it('when two intents match', () => {
    expect(route('write off 2 milk and set milk to 20')).toBeNull();
    expect(route('low stock that expires this week')).toBeNull();
  });
  it('when the extracted argument is not grounded in the text', () => {
    const p = route('how many seven up are left');
    if (p) expect(ground(p, 'how many seven up are left')).not.toBeNull();
  });
});

describe('every routed proposal is schema-valid and grounded', () => {
  it.each([
    'price of cheddar cheese',
    'list 8 products',
    'items low on stock from Nestle',
    'expiring today',
    'end of day report',
    'ultimos tres cobros',
    'write off 5 spoiled tomatoes',
    'change price of tea to 15.25',
  ])('%s', text => {
    const p = route(text);
    expect(p).not.toBeNull();
    expect(Proposal.safeParse(p).success).toBe(true);
    expect(ground(Proposal.parse(p), text)).not.toBeNull();
  });
});
