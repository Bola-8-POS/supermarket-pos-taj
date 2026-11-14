import { describe, expect, it } from 'vitest';
import { formatMoney } from '@shared/lib/format';
import enFeat from '@shared/lib/i18n/locales/en-US/featMgmt.json';
import esFeat from '@shared/lib/i18n/locales/es-MX/featMgmt.json';
import { present, type LookupReply } from './presenter';
import { AssistantCodeSchema } from './proposal';

const row = (over: Partial<LookupReply['rows'][number]> = {}): LookupReply['rows'][number] => ({
  productId: '11111111-1111-4111-8111-111111111111',
  name: 'Ghee 500g',
  price: 12.5,
  quantityOnHand: 7,
  barcode: null,
  ...over,
});

describe('present', () => {
  it('renders a found lookup with count, price and stock as typed params', () => {
    const p = present({ type: 'result', kind: 'product.lookup', rows: [row()], more: false });
    expect(p.key).toBe('assistant.lookup.found');
    expect(p.params).toEqual({ count: 1 });
    expect(p.lines).toEqual([
      { key: 'assistant.lookup.row', params: { name: 'Ghee 500g', price: formatMoney(12.5), stock: 7 } },
    ]);
  });

  it('uses the no-stock key when the product has no inventory row', () => {
    const p = present({ type: 'result', kind: 'product.lookup', rows: [row({ quantityOnHand: null })], more: false });
    expect(p.lines[0]?.key).toBe('assistant.lookup.rowNoStock');
  });

  it('uses the located keys and passes the shelf text as a param when a location is recorded', () => {
    const p = present({
      type: 'result',
      kind: 'product.lookup',
      rows: [row({ shelfLocation: ' Pasillo 3 / A ' }), row({ quantityOnHand: null, shelfLocation: 'B2' })],
      more: false,
    });
    expect(p.lines[0]).toEqual({
      key: 'assistant.lookup.rowAt',
      params: { name: 'Ghee 500g', price: formatMoney(12.5), location: 'Pasillo 3 / A', stock: 7 },
    });
    expect(p.lines[1]?.key).toBe('assistant.lookup.rowNoStockAt');
  });

  it('keeps the base keys (location not recorded) for a null, absent or blank shelf', () => {
    for (const shelfLocation of [null, undefined, '  ']) {
      const p = present({ type: 'result', kind: 'product.lookup', rows: [row({ shelfLocation })], more: false });
      expect(p.lines[0]?.key).toBe('assistant.lookup.row');
    }
  });

  it('adds a "more" line past the row cap', () => {
    const p = present({ type: 'result', kind: 'product.lookup', rows: [row()], more: true });
    expect(p.lines.at(-1)?.key).toBe('assistant.lookup.more');
  });

  it('reports no match with a dedicated key', () => {
    expect(present({ type: 'result', kind: 'product.lookup', rows: [], more: false }).key).toBe(
      'assistant.lookup.none'
    );
  });

  it('renders expiry rows as typed params, expired and today with their own keys', () => {
    const r = (name: string, days: number) => ({
      productId: '11111111-1111-4111-8111-111111111111',
      name,
      expiryDate: '2026-11-10',
      daysUntilExpiry: days,
    });
    const p = present({
      type: 'result',
      kind: 'expiry.list',
      rows: [r('Milk', 3), r('Yogurt', 0), r('Cheese', -2)],
      more: true,
    });
    expect(p.key).toBe('assistant.expiry.found');
    expect(p.params).toEqual({ count: 3 });
    expect(p.lines.map(l => l.key)).toEqual([
      'assistant.expiry.row',
      'assistant.expiry.rowToday',
      'assistant.expiry.rowExpired',
      'assistant.expiry.more',
    ]);
    expect(p.lines[0]?.params).toEqual({ name: 'Milk', date: '2026-11-10', count: 3 });
  });

  it('reports an empty expiry list with a dedicated key', () => {
    expect(present({ type: 'result', kind: 'expiry.list', rows: [], more: false }).key).toBe('assistant.expiry.none');
  });

  it('renders low stock rows, with the supplier header when one was matched', () => {
    const row = { productId: '11111111-1111-4111-8111-111111111111', name: 'Ghee', quantityOnHand: 2, lowStockThreshold: 10 };
    const all = present({ type: 'result', kind: 'stock.low', rows: [row], more: true, supplierName: null });
    expect(all.key).toBe('assistant.lowStock.found');
    expect(all.lines.map(l => l.key)).toEqual(['assistant.lowStock.row', 'assistant.lowStock.more']);
    expect(all.lines[0]?.params).toEqual({ name: 'Ghee', stock: 2, threshold: 10 });
    const bySupplier = present({ type: 'result', kind: 'stock.low', rows: [row], more: false, supplierName: 'Sysco' });
    expect(bySupplier.key).toBe('assistant.lowStock.foundFor');
    expect(bySupplier.params).toEqual({ count: 1, supplier: 'Sysco' });
    expect(present({ type: 'result', kind: 'stock.low', rows: [], more: false, supplierName: null }).key).toBe(
      'assistant.lowStock.none'
    );
  });

  it('renders the supplier choice prompt', () => {
    const p = present({ type: 'choose', kind: 'stock.low', options: [{ id: 'a', name: 'Sysco' }] });
    expect(p.key).toBe('assistant.choose.supplier');
  });

  it('renders the sales summary with one line per payment method that has sales', () => {
    const summary = {
      cajaId: '22222222-2222-4222-8222-222222222222',
      openedAt: '2026-11-08T14:00:00Z',
      closedAt: null,
      summary: {
        totalRevenue: 250, cashSales: 100, cardSales: 120, rappiSales: 10, uberEatsSales: 0,
        bankTransferSales: 20, bankTransferPending: 0, orderCount: 9, tabCount: 0,
        totalExpenses: 0, totalIncome: 0, netBalance: 250,
      },
    };
    const open = present({ type: 'result', kind: 'sales.summary', summary });
    expect(open.key).toBe('assistant.sales.open');
    expect(open.params).toEqual({ total: formatMoney(250), orders: 9 });
    expect(open.lines.map(l => l.key)).toEqual([
      'assistant.sales.cash',
      'assistant.sales.card',
      'assistant.sales.rappi',
      'assistant.sales.bankTransfer',
    ]);
    expect(open.lines[0]?.params).toEqual({ amount: formatMoney(100) });
    expect(present({ type: 'result', kind: 'sales.summary', summary: { ...summary, closedAt: 'x' } }).key).toBe(
      'assistant.sales.closed'
    );
  });

  it('names the product in a NOT_FOUND refusal only when the gateway supplied the staff-typed query', () => {
    expect(present({ type: 'refusal', code: 'NOT_FOUND', query: 'ghee' })).toEqual({
      key: 'assistant.errors.NOT_FOUND_QUERY',
      params: { query: 'ghee' },
      lines: [],
    });
    expect(present({ type: 'refusal', code: 'NOT_FOUND' }).key).toBe('assistant.errors.NOT_FOUND');
  });

  const item = { product_id: '11111111-1111-4111-8111-111111111111', name: 'Ghee', before: 10, after: 8 };

  it('presents a preview with one line per item and an outcome with lines only when executed', () => {
    const preview = present({
      type: 'preview',
      kind: 'inventory.adjust',
      proposalId: 'p',
      payloadHash: 'h',
      expiresInSeconds: 120,
      items: [item, item],
    });
    expect(preview.key).toBe('assistant.adjust.preview');
    expect(preview.params).toEqual({ count: 2 });
    expect(preview.lines).toEqual([
      { key: 'assistant.adjust.row', params: { name: 'Ghee', before: 10, after: 8 } },
      { key: 'assistant.adjust.row', params: { name: 'Ghee', before: 10, after: 8 } },
    ]);
    const done = present({ type: 'outcome', kind: 'inventory.adjust', status: 'executed', items: [item] });
    expect(done.key).toBe('assistant.adjust.executed');
    expect(done.lines).toHaveLength(1);
    for (const status of ['cancelled', 'expired'] as const) {
      const p = present({ type: 'outcome', kind: 'inventory.adjust', status, items: [item] });
      expect(p.key).toBe(`assistant.adjust.${status}`);
      expect(p.lines).toEqual([]);
    }
  });

  const priceItem = { product_id: '11111111-1111-4111-8111-111111111111', name: 'Ghee', before: 12.5, after: 89.5 };

  it('presents a price preview with money-formatted before and after', () => {
    const p = present({
      type: 'preview',
      kind: 'product.price',
      proposalId: 'p',
      payloadHash: 'h',
      expiresInSeconds: 120,
      items: [priceItem],
    });
    expect(p.key).toBe('assistant.price.preview');
    expect(p.lines).toEqual([
      { key: 'assistant.price.row', params: { name: 'Ghee', before: formatMoney(12.5), after: formatMoney(89.5) } },
    ]);
  });

  it('presents price outcomes: executed lists the rows, partial names the items that were not applied', () => {
    const applied = { ...priceItem, result: 'applied' as const };
    const stale = { ...priceItem, name: 'Rice', result: 'stale' as const };
    const mismatch = { ...priceItem, name: 'Milk', result: 'mismatch' as const };
    const done = present({ type: 'outcome', kind: 'product.price', status: 'executed', items: [applied] });
    expect(done.key).toBe('assistant.price.executed');
    expect(done.lines).toHaveLength(1);

    const partial = present({
      type: 'outcome',
      kind: 'product.price',
      status: 'partial',
      items: [applied, stale, applied, mismatch],
    });
    expect(partial.key).toBe('assistant.result.partial');
    expect(partial.params).toEqual({ applied: 2, total: 4, names: 'Rice, Milk' });
    expect(partial.lines.map(l => l.key)).toEqual([
      'assistant.price.row',
      'assistant.price.rowStale',
      'assistant.price.row',
      'assistant.price.rowMismatch',
    ]);

    const failed = present({ type: 'outcome', kind: 'product.price', status: 'failed', items: [stale] });
    expect(failed.key).toBe('assistant.price.failed');
    for (const status of ['cancelled', 'expired'] as const) {
      const p = present({ type: 'outcome', kind: 'product.price', status, items: [priceItem] });
      expect(p.key).toBe(`assistant.price.${status}`);
      expect(p.lines).toEqual([]);
    }
  });

  it('presents a lockout with the local time of the unlock, and the plain refusal without a time', () => {
    const until = '2026-11-08T18:30:00Z';
    const locked = present({ type: 'refusal', code: 'ASSISTANT_LOCKED', until });
    expect(locked.key).toBe('assistant.lockout');
    expect(locked.params).toEqual({
      time: new Date(until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    });
    expect(present({ type: 'refusal', code: 'ASSISTANT_LOCKED' }).key).toBe('assistant.errors.ASSISTANT_LOCKED');
  });

  it('maps every assistant code to an errors key', () => {
    for (const code of AssistantCodeSchema.options) {
      expect(present({ type: 'refusal', code }).key).toBe(`assistant.errors.${code}`);
    }
  });
});

describe('assistant i18n blocks', () => {
  const flat = (o: unknown, prefix = ''): string[] =>
    Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
      typeof v === 'object' && v !== null ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]
    );

  it('en-US and es-MX have the same key set', () => {
    expect(flat(esFeat.assistant).sort()).toEqual(flat(enFeat.assistant).sort());
  });

  it('has an errors key for every assistant code in both locales', () => {
    for (const code of AssistantCodeSchema.options) {
      expect(Object.keys(enFeat.assistant.errors)).toContain(code);
      expect(Object.keys(esFeat.assistant.errors)).toContain(code);
    }
  });
});

describe('present: product.list and sales.recent (Plan 29-12)', () => {
  const sale = (method: string) => ({ time: '2026-11-14T15:00:00Z', total: 42.5, method });
  const hasKey = (key: string) => {
    const get = (o: unknown) => key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);
    return typeof get({ assistant: enFeat.assistant }) === 'string' && typeof get({ assistant: esFeat.assistant }) === 'string';
  };

  it('lists name, price and stock per product, with a "more" line when cut', () => {
    const p = present({ type: 'result', kind: 'product.list', rows: [row(), row({ name: 'Rice', quantityOnHand: null })], more: true, sort: null });
    expect(p).toMatchObject({ key: 'assistant.list.found', params: { count: 2 } });
    expect(p.lines.map(l => l.key)).toEqual(['assistant.list.row', 'assistant.list.rowNoStock', 'assistant.list.more']);
    expect(p.lines[0]?.params).toEqual({ name: 'Ghee 500g', price: formatMoney(12.5), stock: 7 });
  });

  it('says so when the list is empty', () => {
    expect(present({ type: 'result', kind: 'product.list', rows: [], more: false, sort: null }).key).toBe('assistant.list.none');
  });

  it('recent sales: one line per sale (time, total, method), own-scope heading for a cashier', () => {
    const all = present({ type: 'result', kind: 'sales.recent', sales: [sale('cash'), sale('uber_eats')], scope: 'all' });
    expect(all).toMatchObject({ key: 'assistant.recent.found', params: { count: 2 } });
    expect(all.lines.map(l => l.key)).toEqual(['assistant.recent.row.cash', 'assistant.recent.row.uber_eats']);
    const own = present({ type: 'result', kind: 'sales.recent', sales: [sale('tab_transfer')], scope: 'own' });
    expect(own.key).toBe('assistant.recent.foundOwn');
    expect(own.lines[0]?.key).toBe('assistant.recent.row.other');
    expect(present({ type: 'result', kind: 'sales.recent', sales: [], scope: 'own' }).key).toBe('assistant.recent.noneOwn');
    expect(present({ type: 'result', kind: 'sales.recent', sales: [], scope: 'all' }).key).toBe('assistant.recent.none');
  });

  it('every key the new replies can produce exists in en-US and es-MX', () => {
    const keys = [
      'assistant.list.row', 'assistant.list.rowNoStock', 'assistant.list.more', 'assistant.list.none',
      'assistant.recent.none', 'assistant.recent.noneOwn',
      ...['cash', 'card', 'rappi', 'uber_eats', 'bank_transfer', 'other'].map(m => `assistant.recent.row.${m}`),
    ];
    for (const k of keys) expect(hasKey(k), k).toBe(true);
    for (const base of ['assistant.list.found', 'assistant.recent.found', 'assistant.recent.foundOwn']) {
      for (const suffix of ['_one', '_other']) expect(hasKey(base + suffix), base + suffix).toBe(true);
    }
  });
});

describe('list heading states the sort', () => {
  const base = { type: 'result' as const, kind: 'product.list' as const, rows: [row()], more: false };
  it.each([
    ['price_asc', 'assistant.list.found_price_asc'],
    ['price_desc', 'assistant.list.found_price_desc'],
    ['stock_low', 'assistant.list.found_stock_low'],
    ['newest', 'assistant.list.found_newest'],
    ['name', 'assistant.list.found'],
    [null, 'assistant.list.found'],
  ] as const)('%s', (sort, key) => {
    expect(present({ ...base, sort })).toMatchObject({ key, params: { count: 1 } });
  });
});

describe('price preview with a percent', () => {
  it('shows old -> new and the percent for the product that was discounted only', () => {
    const items = [
      { product_id: '11111111-1111-4111-8111-111111111111', name: 'Atta', before: 330, after: 297 },
      { product_id: '22222222-2222-4222-8222-222222222222', name: 'Rice', before: 10, after: 12 },
    ];
    const p = present({ type: 'preview', kind: 'product.price', proposalId: 'p', payloadHash: 'h', expiresInSeconds: 120, items, percents: { '11111111-1111-4111-8111-111111111111': 10 } });
    expect(p.lines[0]).toEqual({ key: 'assistant.price.rowPercent', params: { name: 'Atta', before: formatMoney(330), after: formatMoney(297), percent: 10 } });
    expect(p.lines[1]?.key).toBe('assistant.price.row');
  });
});
