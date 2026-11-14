import { describe, expect, it, vi } from 'vitest';
import type { supabase } from '@shared/lib/supabase';
import { EXPIRY_ROW_CAP, LOOKUP_ROW_CAP, LOW_STOCK_ROW_CAP, expiryList, lowStock, productLookup, salesSummary } from './reads';

type Client = typeof supabase;

/** Chainable stand-in for the PostgREST builder: records calls, resolves the queued responses in order. */
function fakeClient(responses: { data: unknown; error: { message: string } | null }[]) {
  const calls: [string, unknown[]][] = [];
  const queue = [...responses];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'ilike', 'order', 'limit']) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    };
  }
  builder['then'] = (resolve: (v: unknown) => void) => { resolve(queue.shift() ?? { data: [], error: null }); };
  return { client: { from: () => builder } as unknown as Client, calls };
}

const dbRow = (i: number, inventory: unknown = { quantity_on_hand: 4 }) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `Ghee ${i}`,
  base_price: 12.5,
  barcode: null,
  inventory,
});

describe('productLookup', () => {
  it('escapes LIKE wildcards in the typed query', async () => {
    const { client, calls } = fakeClient([{ data: [], error: null }]);
    await productLookup('50%_off\\', client);
    expect(calls.find(c => c[0] === 'ilike')?.[1]).toEqual(['name', '%50\\%\\_off\\\\%']);
  });

  it('caps at 10 rows and reports more', async () => {
    const data = Array.from({ length: LOOKUP_ROW_CAP + 1 }, (_v, i) => dbRow(i + 1));
    const { client } = fakeClient([{ data, error: null }]);
    const res = await productLookup('ghee', client);
    expect(res.ok && res.data.rows).toHaveLength(LOOKUP_ROW_CAP);
    expect(res.ok && res.data.more).toBe(true);
  });

  it('accepts an inventory array and a missing inventory row', async () => {
    const { client } = fakeClient([{ data: [dbRow(1, [{ quantity_on_hand: 9 }]), dbRow(2, null)], error: null }]);
    const res = await productLookup('ghee', client);
    expect(res.ok && res.data.rows.map(r => r.quantityOnHand)).toEqual([9, null]);
  });

  it('tries the exact barcode first for an 8-14 digit query', async () => {
    const { client, calls } = fakeClient([{ data: [dbRow(1)], error: null }]);
    const res = await productLookup('7501234567890', client);
    expect(res.ok && res.data.rows).toHaveLength(1);
    expect(calls.some(c => c[0] === 'eq' && c[1][0] === 'barcode')).toBe(true);
    expect(calls.some(c => c[0] === 'ilike')).toBe(false);
  });

  it('falls back to the name search when no barcode matches', async () => {
    const { client, calls } = fakeClient([
      { data: [], error: null },
      { data: [dbRow(1)], error: null },
    ]);
    const res = await productLookup('7501234567890', client);
    expect(res.ok && res.data.rows).toHaveLength(1);
    expect(calls.some(c => c[0] === 'ilike')).toBe(true);
  });

  it('returns DATA_UNAVAILABLE on a Supabase error', async () => {
    const { client } = fakeClient([{ data: null, error: { message: 'boom' } }]);
    expect(await productLookup('ghee', client)).toEqual({ ok: false, error: { code: 'DATA_UNAVAILABLE' } });
  });

  it('returns DATA_UNAVAILABLE when the client throws (network failure)', async () => {
    const client = {
      from: () => {
        throw new Error('network');
      },
    } as unknown as Client;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await productLookup('ghee', client)).toEqual({ ok: false, error: { code: 'DATA_UNAVAILABLE' } });
  });
});

/** Builder stand-in that also supports `maybeSingle` (settings read) and resolves queued responses in order. */
function fakeExpiryClient(responses: { data: unknown; error: { message: string } | null }[]) {
  const calls: [string, unknown[]][] = [];
  const queue = [...responses];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'lte', 'order', 'limit']) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    };
  }
  builder['maybeSingle'] = () => Promise.resolve(queue.shift() ?? { data: null, error: null });
  builder['then'] = (resolve: (v: unknown) => void) => { resolve(queue.shift() ?? { data: [], error: null }); };
  const client = { from: () => builder } as unknown as Client;
  return { client, calls };
}

const expiryDb = (i: number, date: string) => ({
  expiry_date: date,
  product: { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Milk ${i}` },
});

describe('expiryList', () => {
  // Local-constructed Date: the cutoff is the till's calendar date, so these tests are timezone independent.
  const lateEvening = new Date(2026, 10, 8, 23, 30);

  it('uses the till-local calendar date, not the UTC date, for the cutoff', async () => {
    const { client, calls } = fakeExpiryClient([{ data: [], error: null }]);
    await expiryList(7, client, lateEvening);
    expect(calls.find(c => c[0] === 'lte')?.[1]).toEqual(['expiry_date', '2026-11-15']);
  });

  it('uses the settings threshold when withinDays is null and falls back to 14', async () => {
    const withSetting = fakeExpiryClient([
      { data: { value: { thresholdDays: 30 } }, error: null },
      { data: [], error: null },
    ]);
    await expiryList(null, withSetting.client, lateEvening);
    expect(withSetting.calls.find(c => c[0] === 'lte')?.[1]).toEqual(['expiry_date', '2026-12-08']);

    const noSetting = fakeExpiryClient([
      { data: null, error: null },
      { data: [], error: null },
    ]);
    await expiryList(null, noSetting.client, lateEvening);
    expect(noSetting.calls.find(c => c[0] === 'lte')?.[1]).toEqual(['expiry_date', '2026-11-22']);
  });

  it('orders by expiry date, asks for 26 rows, returns 25 and reports more', async () => {
    const data = Array.from({ length: EXPIRY_ROW_CAP + 1 }, (_v, i) => expiryDb(i + 1, '2026-11-10'));
    const { client, calls } = fakeExpiryClient([{ data, error: null }]);
    const res = await expiryList(7, client, lateEvening);
    expect(calls.find(c => c[0] === 'order')?.[1]).toEqual(['expiry_date']);
    expect(calls.find(c => c[0] === 'limit')?.[1]).toEqual([EXPIRY_ROW_CAP + 1]);
    expect(res.ok && res.data.rows).toHaveLength(EXPIRY_ROW_CAP);
    expect(res.ok && res.data.more).toBe(true);
  });

  it('computes days until expiry from calendar dates (negative when already expired)', async () => {
    const { client } = fakeExpiryClient([
      { data: [expiryDb(1, '2026-11-06'), expiryDb(2, '2026-11-08'), expiryDb(3, '2026-11-11')], error: null },
    ]);
    const res = await expiryList(7, client, lateEvening);
    expect(res.ok && res.data.rows.map(r => r.daysUntilExpiry)).toEqual([-2, 0, 3]);
  });

  it('returns DATA_UNAVAILABLE on a Supabase error', async () => {
    const { client } = fakeExpiryClient([{ data: null, error: { message: 'boom' } }]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await expiryList(7, client, lateEvening)).toEqual({ ok: false, error: { code: 'DATA_UNAVAILABLE' } });
  });
});

const CAJA_ID = '22222222-2222-4222-8222-222222222222';
const summaryPayload = {
  ok: true,
  caja_id: CAJA_ID,
  opened_at: '2026-11-08T14:00:00Z',
  closed_at: null,
  report: {
    ok: true,
    cajaSession: {
      id: CAJA_ID,
      openedBy: '33333333-3333-4333-8333-333333333333',
      openedAt: '2026-11-08T14:00:00Z',
      closedAt: null,
      closedBy: null,
      openingCash: 100,
      closingCash: null,
      status: 'open',
      notes: null,
    },
    summary: {
      totalRevenue: 250,
      cashSales: 100,
      cardSales: 120,
      rappiSales: 10,
      uberEatsSales: 0,
      bankTransferSales: 20,
      bankTransferPending: 0,
      orderCount: 9,
      tabCount: 0,
      totalExpenses: 0,
      totalIncome: 0,
      netBalance: 250,
    },
    cashReconciliation: { openingCash: 100, cashSales: 100, expectedCash: 200, closingCash: null, variance: null },
    topProducts: [],
    staffSummary: [],
    cajaEntries: [],
  },
};

function rpcClient(response: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(response);
  return { client: { rpc } as unknown as Client, rpc };
}

describe('salesSummary', () => {
  it('calls the wrapper RPC with the terminal id, never get_caja_report', async () => {
    const { client, rpc } = rpcClient({ data: summaryPayload, error: null });
    const res = await salesSummary('POS-7', client);
    expect(rpc).toHaveBeenCalledWith('assistant_sales_summary', { p_terminal_id: 'POS-7' });
    expect(res.ok && res.data.summary.cardSales).toBe(120);
    expect(res.ok && res.data.cajaId).toBe(CAJA_ID);
  });

  it.each([
    ['AUTH_FORBIDDEN', 'AUTH_FORBIDDEN'],
    ['NO_CAJA', 'NO_CAJA'],
    ['INVALID_ARGUMENT', 'DATA_UNAVAILABLE'],
    ['SOMETHING_NEW', 'DATA_UNAVAILABLE'],
  ] as const)('maps the RPC refusal %s to %s', async (rpcCode, code) => {
    const { client } = rpcClient({ data: { ok: false, code: rpcCode }, error: null });
    expect(await salesSummary('POS-1', client)).toEqual({ ok: false, error: { code } });
  });

  it('returns DATA_UNAVAILABLE on an RPC error or a payload that breaks the contract', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failed = rpcClient({ data: null, error: { message: 'boom' } });
    expect(await salesSummary('POS-1', failed.client)).toEqual({ ok: false, error: { code: 'DATA_UNAVAILABLE' } });
    const broken = rpcClient({ data: { ok: true }, error: null });
    expect(await salesSummary('POS-1', broken.client)).toEqual({ ok: false, error: { code: 'DATA_UNAVAILABLE' } });
  });
});

/** Builder stand-in routing by table: each `from(table)` resolves the next queued response for that table. */
function fakeTableClient(byTable: Record<string, { data: unknown; error: { message: string } | null }[]>) {
  const calls: [string, string, unknown[]][] = [];
  const queues = Object.fromEntries(Object.entries(byTable).map(([k, v]) => [k, [...v]]));
  const client = {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'ilike', 'in', 'order', 'limit', 'range']) {
        builder[m] = (...args: unknown[]) => {
          calls.push([table, m, args]);
          return builder;
        };
      }
      builder['then'] = (resolve: (v: unknown) => void) => {
        resolve(queues[table]?.shift() ?? { data: [], error: null });
      };
      return builder;
    },
  } as unknown as Client;
  return { client, calls };
}

const PID = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const invDb = (i: number, qty: number, threshold: number) => ({
  product_id: PID(i),
  quantity_on_hand: qty,
  low_stock_threshold: threshold,
  product: { id: PID(i), name: `Item ${String(i).padStart(2, '0')}` },
});
const SUP_A = '11111111-1111-4111-8111-111111111111';
const SUP_B = '22222222-2222-4222-8222-222222222222';

describe('lowStock', () => {
  it('with no supplier lists only products at or below their own threshold, lowest stock first', async () => {
    const { client } = fakeTableClient({
      inventory: [{ data: [invDb(1, 3, 10), invDb(2, 50, 10), invDb(3, 10, 10), invDb(4, 0, 5)], error: null }],
    });
    const res = await lowStock({ query: null }, client);
    expect(res.ok && res.data.type === 'rows' && res.data.rows.map(r => r.name)).toEqual([
      'Item 04',
      'Item 01',
      'Item 03',
    ]);
  });

  it('caps at 25 rows and reports more', async () => {
    const data = Array.from({ length: LOW_STOCK_ROW_CAP + 5 }, (_v, i) => invDb(i + 1, 1, 10));
    const { client } = fakeTableClient({ inventory: [{ data, error: null }] });
    const res = await lowStock({ query: null }, client);
    expect(res.ok && res.data.type === 'rows' && res.data.rows).toHaveLength(LOW_STOCK_ROW_CAP);
    expect(res.ok && res.data.type === 'rows' && res.data.more).toBe(true);
  });

  it('escapes LIKE wildcards in the supplier query', async () => {
    const { client, calls } = fakeTableClient({ suppliers: [{ data: [], error: null }] });
    await lowStock({ query: '50%_x\\' }, client);
    expect(calls.find(c => c[0] === 'suppliers' && c[1] === 'ilike')?.[2]).toEqual(['name', '%50\\%\\_x\\\\%']);
  });

  it('returns NOT_FOUND when no supplier matches', async () => {
    const { client } = fakeTableClient({ suppliers: [{ data: [], error: null }] });
    expect(await lowStock({ query: 'zzz' }, client)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('returns a typed choice when several suppliers match, and reads no inventory', async () => {
    const { client, calls } = fakeTableClient({
      suppliers: [{ data: [{ id: SUP_A, name: 'Sysco' }, { id: SUP_B, name: 'Susan Foods' }], error: null }],
    });
    const res = await lowStock({ query: 'su' }, client);
    expect(res).toEqual({
      ok: true,
      data: { type: 'choose', options: [{ id: SUP_A, name: 'Sysco' }, { id: SUP_B, name: 'Susan Foods' }] },
    });
    expect(calls.some(c => c[0] === 'inventory')).toBe(false);
  });

  it('filters through supplier_products when one supplier matches', async () => {
    const { client, calls } = fakeTableClient({
      suppliers: [{ data: [{ id: SUP_A, name: 'Sysco' }], error: null }],
      supplier_products: [{ data: [{ product_id: PID(1) }, { product_id: PID(2) }], error: null }],
      inventory: [{ data: [invDb(1, 2, 10), invDb(2, 99, 10)], error: null }],
    });
    const res = await lowStock({ query: 'sysco' }, client);
    expect(calls.find(c => c[0] === 'inventory' && c[1] === 'in')?.[2]).toEqual(['product_id', [PID(1), PID(2)]]);
    expect(res.ok && res.data.type === 'rows' && res.data.supplierName).toBe('Sysco');
    expect(res.ok && res.data.type === 'rows' && res.data.rows.map(r => r.name)).toEqual(['Item 01']);
  });

  it('re-runs the read for a chosen supplier id without searching suppliers by name', async () => {
    const { client, calls } = fakeTableClient({
      suppliers: [{ data: [{ id: SUP_B, name: 'Susan Foods' }], error: null }],
      supplier_products: [{ data: [{ product_id: PID(3) }], error: null }],
      inventory: [{ data: [invDb(3, 1, 10)], error: null }],
    });
    const res = await lowStock({ supplierId: SUP_B }, client);
    expect(calls.some(c => c[0] === 'suppliers' && c[1] === 'ilike')).toBe(false);
    expect(calls.find(c => c[0] === 'suppliers' && c[1] === 'eq')?.[2]).toEqual(['id', SUP_B]);
    expect(res.ok && res.data.type === 'rows' && res.data.supplierName).toBe('Susan Foods');
  });

  it('returns DATA_UNAVAILABLE on a Supabase error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = fakeTableClient({ inventory: [{ data: null, error: { message: 'boom' } }] });
    expect(await lowStock({ query: null }, client)).toEqual({ ok: false, error: { code: 'DATA_UNAVAILABLE' } });
  });
});
