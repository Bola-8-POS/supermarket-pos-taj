import { describe, expect, it, vi } from 'vitest';
import { fetchAllRows } from './fetch-all-rows';

/** A fake table of `total` numbered rows behind a server that returns at most `cap` rows per request. */
function fakeServer(total: number, cap: number, knownCount = true) {
  const rows = Array.from({ length: total }, (_, i) => i);
  return vi.fn(async (from: number, to: number) => ({
    data: rows.slice(from, Math.min(to, from + cap - 1) + 1),
    error: null,
    count: knownCount ? total : null,
  }));
}

describe('fetchAllRows', () => {
  it('returns every row across three pages', async () => {
    const page = fakeServer(25, 1000);
    const r = await fetchAllRows(page, { pageSize: 10 });
    expect(r.ok && r.data).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(page).toHaveBeenCalledTimes(3);
    expect(page.mock.calls).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
    ]);
  });

  it('advances by the rows received when the server caps a page below the page size', async () => {
    const page = fakeServer(25, 4);
    const r = await fetchAllRows(page, { pageSize: 10 });
    expect(r.ok && r.data).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(page.mock.calls.map(c => c[0])).toEqual([0, 4, 8, 12, 16, 20, 24]);
  });

  it('an error on any page is an Err, never a partial list', async () => {
    const page = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2], error: null, count: 4 })
      .mockResolvedValueOnce({ data: null, error: { message: 'boom' }, count: null });
    const r = await fetchAllRows<number>(page, { pageSize: 2 });
    expect(r.ok).toBe(false);
  });

  it('stops on an empty page when the count is unknown', async () => {
    const page = fakeServer(5, 1000, false);
    const r = await fetchAllRows(page, { pageSize: 2 });
    expect(r.ok && r.data).toEqual([0, 1, 2, 3, 4]);
    expect(page).toHaveBeenCalledTimes(4);
  });

  it('one request when the first page holds everything', async () => {
    const page = fakeServer(7, 1000);
    const r = await fetchAllRows(page);
    expect(r.ok && r.data).toHaveLength(7);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('a row removed between pages is refetched or an Err, never a short list', async () => {
    // 4 rows at first; row 0 is deleted after page 1 is served: page 2 reports count 3 and is short.
    const calls: number[] = [];
    const page = vi.fn(async (from: number) => {
      calls.push(from);
      if (calls.length === 1) return { data: [0, 1], error: null, count: 4 };
      if (calls.length === 2) return { data: [3], error: null, count: 3 };
      return from === 0 ? { data: [1, 2], error: null, count: 3 } : { data: [3], error: null, count: 3 };
    });
    const r = await fetchAllRows<number>(page, { pageSize: 2 });
    expect(r.ok && r.data).toEqual([1, 2, 3]);
  });

  it('an empty page before the count is not ok', async () => {
    const page = vi.fn(async (from: number) =>
      from === 0 ? { data: [0, 1], error: null, count: 4 } : { data: [], error: null, count: 4 }
    );
    const r = await fetchAllRows<number>(page, { pageSize: 2 });
    expect(r.ok).toBe(false);
  });

  it('a count that changes between pages restarts the fetch', async () => {
    let n = 0;
    const page = vi.fn(async (from: number) => {
      n++;
      if (n === 1) return { data: [0, 1], error: null, count: 4 };
      if (n === 2) return { data: [2, 3], error: null, count: 5 };
      return { data: [0, 1, 2, 3].slice(from, from + 2), error: null, count: 4 };
    });
    const r = await fetchAllRows<number>(page, { pageSize: 2 });
    expect(r.ok && r.data).toEqual([0, 1, 2, 3]);
  });

  it('three inconsistent attempts return an error', async () => {
    const page = vi.fn(async (from: number) =>
      from === 0 ? { data: [0, 1], error: null, count: 4 } : { data: [], error: null, count: 4 }
    );
    const r = await fetchAllRows<number>(page, { pageSize: 2 });
    expect(r.ok).toBe(false);
    expect(page.mock.calls.filter(c => c[0] === 0)).toHaveLength(3);
  });

  it('a thrown fetch while offline is NETWORK_OFFLINE', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const r = await fetchAllRows<number>(() => Promise.reject(new TypeError('Failed to fetch')));
    online.mockRestore();
    expect(!r.ok && r.error.code).toBe('NETWORK_OFFLINE');
  });
});
