import { describe, expect, it } from 'vitest';
import { ground } from './grounding';
import type { Proposal } from './proposal';

const lookup = (query: string): Proposal => ({ kind: 'product.lookup', args: { query } });
const low = (supplierQuery: string | null): Proposal => ({ kind: 'stock.low', args: { supplierQuery } });
const list = (args: Partial<{ query: string | null; limit: number | null; sort: 'name' | 'stock_low' | 'newest' | null }>): Proposal => ({
  kind: 'product.list',
  args: { query: null, limit: null, sort: null, ...args },
});

describe('ground', () => {
  it('keeps a value that is in the message, ignoring case, accents and plurals', () => {
    expect(ground(lookup('ghee'), 'Price of GHEE')).toEqual(lookup('ghee'));
    expect(ground(lookup('arroz'), 'cuánto cuesta el Arróz')).toEqual(lookup('arroz'));
    expect(ground(lookup('tomato'), 'price of tomatoes')).toEqual(lookup('tomato'));
    expect(ground(lookup('leches'), 'precio de la leche')).toEqual(lookup('leches'));
    expect(ground(lookup('basmati rice'), 'how many units of basmati rice in stock')).toEqual(lookup('basmati rice'));
  });

  it('tolerates a one-letter typo on longer words', () => {
    expect(ground(lookup('basmati'), 'precio del basmatti')).toEqual(lookup('basmati'));
  });

  it('clarifies (null) when a required product query was invented', () => {
    expect(ground(lookup('ghee'), 'Show me 10 product prices')).toBeNull();
    expect(ground(lookup('product'), 'show me the products')).toBeNull();
  });

  it('nulls an invented optional supplier', () => {
    expect(ground(low('Sysco'), 'low stock items')).toEqual(low(null));
    expect(ground(low('Basmati Rice'), 'how many units of basmati rice in stock')).toEqual(low('Basmati Rice'));
    expect(ground(low('Sysco'), 'qué hay con poco stock de sysco')).toEqual(low('Sysco'));
  });

  it('grounds day counts: digits or a time word, else null', () => {
    const exp = (withinDays: number | null): Proposal => ({ kind: 'expiry.list', args: { withinDays } });
    expect(ground(exp(7), 'what expires in 7 days')).toEqual(exp(7));
    expect(ground(exp(7), 'what expires this week')).toEqual(exp(7));
    expect(ground(exp(7), 'qué caduca esta semana')).toEqual(exp(7));
    expect(ground(exp(30), 'what expires soon')).toEqual(exp(null));
    expect(ground(exp(0), 'qué caduca hoy')).toEqual(exp(0));
  });

  it('product.list: drops invented query/limit/sort, keeps grounded ones', () => {
    expect(ground(list({ query: 'ghee', limit: 10 }), 'Show me 10 product prices')).toEqual(list({ limit: 10 }));
    expect(ground(list({ limit: 25 }), 'show me the products')).toEqual(list({}));
    expect(ground(list({ query: 'leche', sort: 'stock_low' }), 'lista de leche con menos stock')).toEqual(
      list({ query: 'leche', sort: 'stock_low' })
    );
    expect(ground(list({ sort: 'newest' }), 'show me the products')).toEqual(list({}));
    expect(ground(list({ query: 'products' }), 'show me the products')).toEqual(list({}));
  });

  it('sales.recent: limit only when typed', () => {
    const recent = (limit: number | null): Proposal => ({ kind: 'sales.recent', args: { limit } });
    expect(ground(recent(5), 'what was the last payment')).toEqual(recent(null));
    expect(ground(recent(3), 'últimas 3 ventas')).toEqual(recent(3));
  });

  it('writes: every product name, delta and price must come from the message', () => {
    const adj = (query: string, delta: number): Proposal => ({
      kind: 'inventory.adjust',
      args: { reason: 'waste', items: [{ query, delta }] },
    });
    expect(ground(adj('ghee', -2), 'write off 2 expired ghee')).toEqual(adj('ghee', -2));
    expect(ground(adj('ghee', -2), 'write off expired stock')).toBeNull();
    expect(ground(adj('ghee', -5), 'write off 2 expired ghee')).toBeNull();
    const price = (query: string, priceCents: number): Proposal => ({
      kind: 'product.price',
      args: { items: [{ query, priceCents, percentOff: null }] },
    });
    expect(ground(price('ghee', 8950), 'set ghee to $89.50')).toEqual(price('ghee', 8950));
    expect(ground(price('leche', 2400), 'pon la leche a 24')).toEqual(price('leche', 2400));
    expect(ground(price('ghee', 9000), 'set ghee to $89.50')).toBeNull();
    expect(ground(price('rice', 2000), 'set ghee to 20')).toBeNull();
  });

  it('passes refusals and argument-free proposals through', () => {
    const r: Proposal = { kind: 'refuse', reason: 'unsupported' };
    expect(ground(r, 'x')).toEqual(r);
    const s: Proposal = { kind: 'sales.summary', args: {} };
    expect(ground(s, 'x')).toEqual(s);
  });

  it('grounds number words (en and es) like digits', () => {
    expect(ground(list({ limit: 12 }), 'give me twelve products')).toEqual(list({ limit: 12 }));
    expect(ground(list({ limit: 35 }), 'dame treinta y cinco productos')).toEqual(list({ limit: 35 }));
    expect(ground(list({ limit: 12 }), 'give me nine products')).toEqual(list({ limit: null }));
  });
});

describe('price sort and percent discount grounding', () => {
  const lst = (sort: 'price_asc' | 'price_desc' | 'name' | null, limit: number | null = null): Proposal => ({
    kind: 'product.list',
    args: { query: null, limit, sort },
  });
  const disc = (percentOff: number, priceCents: number | null = null, query = 'atta'): Proposal => ({
    kind: 'product.price',
    args: { items: [{ query, priceCents, percentOff }] },
  });
  it('keeps a price sort only when the staff asked for it, in en and es', () => {
    expect(ground(lst('price_asc', 5), 'the 5 cheapest products')).toEqual(lst('price_asc', 5));
    expect(ground(lst('price_desc'), 'los productos más caros')).toEqual(lst('price_desc'));
    expect(ground(lst('price_asc'), 'show me products')).toEqual(lst(null));
    expect(ground(lst('price_desc'), 'the cheapest products')).toBeNull(); // wrong direction: ranking asked, not honoured
  });
  it('never answers a ranking it cannot honour with a name-sorted list', () => {
    expect(ground(lst(null), 'show me the cheapest products')).toBeNull(); // the model dropped the sort
    expect(ground(lst('name'), 'list the best selling products')).toBeNull();
    expect(ground(lst(null), 'los productos más vendidos')).toBeNull();
    expect(ground(lst(null, 10), 'list 10 products')).toEqual(lst(null, 10));
  });
  it('a ranking word inside the typed product name is not a ranking', () => {
    const named: Proposal = { kind: 'product.list', args: { query: 'Top Ramen', limit: null, sort: null } };
    expect(ground(named, 'list Top Ramen')).toEqual(named);
  });
  it('lowest price is not lowest stock', () => {
    const stock: Proposal = { kind: 'product.list', args: { query: null, limit: null, sort: 'stock_low' } };
    expect(ground(stock, 'list products with the lowest price')).toBeNull();
  });
  it('the percent must be typed with a percent marker; an untyped one makes the proposal null', () => {
    expect(ground(disc(10), 'put 10% discount on atta')).toEqual(disc(10));
    expect(ground(disc(10), 'ten percent off atta')).toEqual(disc(10));
    expect(ground(disc(10), 'descuento de 10 por ciento al atta')).toEqual(disc(10));
    expect(ground(disc(15), 'put 10% discount on atta')).toBeNull();
    expect(ground(disc(10), 'put atta at 10')).toBeNull(); // 10 is a price here, not a percent
  });
  it('drops a model-supplied absolute price when a percent is present', () => {
    expect(ground(disc(10, 5000), 'put 10% discount on atta')).toEqual(disc(10, null));
  });
  it('a percent is grounded only by a reduction word, never by an increase word', () => {
    expect(ground(disc(10, null, 'ghee'), 'raise ghee price by 10%')).toBeNull();
    expect(ground(disc(10, null, 'ghee'), 'sube el ghee 10%')).toBeNull();
    expect(ground(disc(10, null, 'ghee'), 'ghee 10%')).toBeNull();
    expect(ground(disc(10, null, 'ghee'), 'ghee 10% off')).toEqual(disc(10, null, 'ghee'));
    expect(ground(disc(10, null, 'ghee'), 'baja el ghee 10%')).toEqual(disc(10, null, 'ghee'));
  });
  it('a percent inside the product name is not a discount; the typed price stays', () => {
    expect(ground(disc(2, 350, '2% milk'), 'set 2% milk to 3.50')).toEqual({
      kind: 'product.price',
      args: { items: [{ query: '2% milk', priceCents: 350, percentOff: null }] },
    });
    expect(ground(disc(2, null, '2% milk'), 'set 2% milk to 3.50')).toBeNull();
  });
  it('a decimal-comma percent is 1.5, so a whole model percent is not grounded', () => {
    expect(ground(disc(5, null, 'ghee'), 'el ghee con 1,5% de descuento')).toBeNull();
    expect(ground(disc(1, null, 'ghee'), 'el ghee con 1,5% de descuento')).toBeNull();
  });
  it('a stock word refuses a percent proposal', () => {
    expect(ground(disc(10, null, 'ghee'), 'reduce ghee stock by 10%')).toBeNull();
    expect(ground(disc(10, null, 'ghee'), 'baja 10% el inventario del ghee')).toBeNull();
  });
  it('ranking words are phrases: adjectives and "al por mayor" are not rankings', () => {
    const named = (q: string | null): Proposal => ({ kind: 'product.list', args: { query: q, limit: null, sort: null } });
    expect(ground(named('supplier'), 'list products from the new supplier')).not.toBeNull(); // not an UNMAPPED_RANK refusal
    expect(ground(named('fat'), 'show low fat products')).toEqual(named('fat'));
    expect(ground(named(null), 'lista de productos al por mayor')).toEqual(named(null));
    expect(ground(named(null), 'show products with low stock')).toBeNull();
    expect(ground(named(null), 'muestra los productos más nuevos')).toBeNull();
    expect(ground(lst('price_asc'), 'productos con mejor precio')).toEqual(lst('price_asc'));
    expect(ground(lst('price_asc'), 'show products with the best price')).toEqual(lst('price_asc'));
  });
});

