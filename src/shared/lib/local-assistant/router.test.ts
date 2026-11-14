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
    expect(args('change price of tea to 15.25')).toEqual({ items: [{ query: 'tea', priceCents: 1525, percentOff: null }] });
    expect(args('cambia el precio de la sal a 18')).toEqual({ items: [{ query: 'sal', priceCents: 1800, percentOff: null }] });
    expect(args('ponle 20 pesos a la sal')).toEqual({ items: [{ query: 'sal', priceCents: 2000, percentOff: null }] });
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

// Phrases below are in no fixture (tuning, holdout, holdout-2).
describe('product.list price sort', () => {
  it.each([
    ['what are the 8 least expensive products', 'price_asc', 8],
    ['list the 4 priciest items', 'price_desc', 4],
    ['give me the cheapest products please', 'price_asc', null],
    ['ensename los 6 articulos mas baratos', 'price_asc', 6],
    ['muestra los 9 productos mas costosos', 'price_desc', 9],
    ['cuales son los productos mas economicos', 'price_asc', null],
    ['los quince productos de menor precio', 'price_asc', 15],
    ['show 3 products with the highest price', 'price_desc', 3],
  ])('%s', (text, sort, limit) => {
    expect(args(text)).toEqual({ query: null, limit, sort });
  });
  it('lowest stock stays a stock sort, price words win only when asked', () => {
    expect(args('show the 5 products with the lowest stock')).toMatchObject({ sort: 'stock_low' });
  });
  it('a category or a second ranking goes to the model, never to a name-sorted list', () => {
    expect(route('show me the 5 cheapest dairy products')).toBeNull();
    expect(route('cheapest newest products')).toBeNull();
    expect(route('show me the most popular products')).toEqual({ kind: 'refuse', reason: 'unsupported' }); // unmapped ranking word
    expect(route('lista los productos mas populares')).toEqual({ kind: 'refuse', reason: 'unsupported' });
    expect(route('make it cheaper')).toBeNull();
  });
});

describe('percent discount is a price change proposal carrying the percent', () => {
  const item = (text: string): unknown => (args(text) as { items: unknown[] } | undefined)?.items[0];
  it.each([
    ['take 7 percent off sugar', 'sugar', 7],
    ['give 25% discount on Colgate toothpaste 100g', 'colgate toothpaste 100g', 25],
    ['lower the price of oat milk by 8%', 'oat milk', 8],
    ['please reduce flour by ten percent', 'flour', 10],
    ['aplica 18% de descuento al detergente Ariel', 'detergente ariel', 18],
    ['rebaja 40% a la sal', 'sal', 40],
    ['hazle 20 por ciento de descuento a la miel', 'miel', 20],
    ['descuento de 5% al azucar', 'azucar', 5],
  ])('%s', (text, query, percentOff) => {
    expect(item(text)).toEqual({ query: expect.stringMatching(new RegExp(query, 'i')) as string, priceCents: null, percentOff });
    expect(kind(text)).toBe('product.price');
  });
  it('refuses a percent outside 1-90 or not whole, never a price', () => {
    for (const t of ['put 95% discount on ghee', '0% discount on tea', 'descuento de 100% al arroz', '12.5% discount on rice']) {
      expect(route(t)).toEqual({ kind: 'refuse', reason: 'unsupported' });
    }
  });
  it('needs the product after the percent: a percent in a sentence naming the product first is left to the model', () => {
    expect(route('ghee gets 10% off for the weekend sale')).toBeNull();
    expect(route('10% discount')).toBeNull();
  });
  it('keeps a percent in a product name a lookup, not a discount', () => {
    expect(kind('price of 2% milk')).toBe('product.lookup');
  });
});

describe('review fixes: stock words, increases, ranking phrases', () => {
  it('a stock word is never a price discount', () => {
    expect(route('reduce ghee stock by 10%')).toEqual({ kind: 'refuse', reason: 'unsupported' });
    expect(route('lower ghee inventory by 10 percent')).toEqual({ kind: 'refuse', reason: 'unsupported' });
    expect(route('baja 10% las existencias del ghee')).toEqual({ kind: 'refuse', reason: 'unsupported' });
  });
  it('an increase is never routed as a discount', () => {
    for (const t of ['raise ghee price by 10%', 'sube el ghee 10%', 'sube 10% al ghee']) {
      expect(JSON.stringify(route(t))).not.toContain('percentOff":10');
    }
  });
  it('"1,5%" is refused as not whole', () => {
    expect(route('rebaja 1,5% al ghee')).toEqual({ kind: 'refuse', reason: 'unsupported' });
  });
  it('mayor in "al por mayor" and new/low adjectives are not rankings', () => {
    expect(route('lista de productos al por mayor')).not.toEqual({ kind: 'refuse', reason: 'unsupported' });
    expect(args('list products from the new supplier')).toMatchObject({ sort: null });
    expect(route('muestra productos con mayor stock')).toEqual({ kind: 'refuse', reason: 'unsupported' });
  });
  it('best price / mejor precio is price_asc', () => {
    expect(args('show me the products with the best price')).toMatchObject({ sort: 'price_asc' });
    expect(args('productos con mejor precio')).toMatchObject({ sort: 'price_asc' });
  });
  it('phrase-based newest', () => {
    expect(args('show the newest products')).toMatchObject({ sort: 'newest' });
    expect(args('muestra los productos mas nuevos')).toMatchObject({ sort: 'newest' });
  });
});

