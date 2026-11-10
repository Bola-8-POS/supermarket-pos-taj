import type { PostgrestError } from '@supabase/supabase-js';
import { err, listChangedError, networkOfflineError, ok, parseSupabaseError, unknownError, type Result } from './result';

/** The API returns at most `max_rows` (1,000 locally) per request, so a longer list must be paged. */
const DEFAULT_PAGE_SIZE = 1000;
const MAX_ATTEMPTS = 3;
/** A caller that forgot `.range()` or the count would otherwise page forever. */
const MAX_PAGES = 10_000;

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null; count: number | null }>;

/**
 * Fetches a whole list in pages. `page` must end its builder in `.range(from, to)` and select with
 * `{ count: 'exact' }`. Advances by the rows actually received (right whatever cap the server
 * applies, even one below `pageSize`). The count of page 1 is held: a later page reporting another
 * count, an empty/null page before the count, or more rows than the count means the table changed
 * while it was paged, so the fetch restarts from offset 0 (3 attempts, then an `Err`). The retry is
 * inside because an `Err` Result is cached as success data and TanStack would never retry it.
 * A list is complete or an error, never a silent part.
 *
 * Accepted limit: a row renamed/reordered across a page boundary shifts the offsets without changing
 * the count, which offset paging cannot detect.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => Page<T>,
  options?: { pageSize?: number }
): Promise<Result<T[]>> {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const rows: T[] = [];
      let expected: number | undefined;
      let consistent = true;
      for (let pages = 0; pages < MAX_PAGES; pages++) {
        const { data, error, count } = await page(rows.length, rows.length + pageSize - 1);
        if (error) return err(parseSupabaseError(error as PostgrestError));
        if (typeof count === 'number') {
          expected ??= count;
          if (count !== expected) {
            consistent = false;
            break;
          }
        }
        if (!data || data.length === 0) {
          if (expected === undefined) {
            if (data === null) return err(unknownError(new Error('list page returned no data')));
            return ok(rows); // count unknown: an empty page is the end
          }
          if (rows.length < expected) consistent = false;
          break;
        }
        rows.push(...data);
        if (expected !== undefined) {
          if (rows.length > expected) {
            consistent = false;
            break;
          }
          if (rows.length === expected) break;
        }
      }
      if (consistent && expected !== undefined && rows.length === expected) return ok(rows);
      if (consistent && expected === undefined) {
        return err(unknownError(new Error('list exceeded the page limit')));
      }
    }
    return err(listChangedError('list changed while it was paged'));
  } catch (e) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return err(networkOfflineError());
    return err(unknownError(e));
  }
}
