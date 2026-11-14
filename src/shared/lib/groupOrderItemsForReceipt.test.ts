import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatModifierLines, groupByCategory, type CategorizedRow } from './groupOrderItemsForReceipt';

type Row = CategorizedRow & { name: string };

function row(name: string, categoryId: string | null, categoryName: string | null): Row {
  return { name, categoryId, categoryName };
}

describe('groupByCategory', () => {
  it('groups rows spanning 2 categories into 2 groups, sorted by categoryName', () => {
    const rows = [
      row('Nachos', 'cat-food', 'Food'),
      row('Beer', 'cat-drinks', 'Drinks'),
    ];
    const groups = groupByCategory(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.categoryName)).toEqual(['Drinks', 'Food']);
  });

  it('preserves input order of items within each group', () => {
    const rows = [
      row('Beer', 'cat-drinks', 'Drinks'),
      row('Tequila', 'cat-drinks', 'Drinks'),
      row('Water', 'cat-drinks', 'Drinks'),
    ];
    const groups = groupByCategory(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map(i => i.name)).toEqual(['Beer', 'Tequila', 'Water']);
  });

  it('collapses categoryId === null rows into one group, always last, even when its name would sort first', () => {
    const rows = [
      row('AAA uncategorized', null, null),
      row('Beer', 'cat-drinks', 'Zzz Drinks'),
    ];
    const groups = groupByCategory(rows);
    expect(groups).toHaveLength(2);
    const last = groups[groups.length - 1];
    expect(last?.categoryId).toBeNull();
    expect(last?.categoryName).toBeNull();
    expect(last?.items.map(i => i.name)).toEqual(['AAA uncategorized']);
  });

  it('keeps two distinct categoryId values sharing the same categoryName as two separate groups', () => {
    const rows = [
      row('Item A', 'cat-1', 'Same Name'),
      row('Item B', 'cat-2', 'Same Name'),
    ];
    const groups = groupByCategory(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.categoryId).sort()).toEqual(['cat-1', 'cat-2']);
  });

  it('treats a row with a categoryId but empty/whitespace categoryName as uncategorized', () => {
    const rows = [row('Item A', 'cat-1', '   ')];
    const groups = groupByCategory(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.categoryId).toBeNull();
    expect(groups[0]?.categoryName).toBeNull();
  });

  it('never mutates the input array', () => {
    const rows = [row('Beer', 'cat-drinks', 'Drinks')];
    const copy = [...rows];
    groupByCategory(rows);
    expect(rows).toEqual(copy);
  });

  it('strips control characters from a category name', () => {
    const rows = [row('Beer', 'cat-drinks', 'Drinks \nExtra')];
    const groups = groupByCategory(rows);
    expect(groups[0]?.categoryName).toBe('Drinks Extra');
  });
});

describe('formatModifierLines', () => {
  it('returns one "  + name" line per modifier', () => {
    const lines = formatModifierLines(['Extra cheese', 'No ice']);
    expect(lines).toEqual(['  + Extra cheese', '  + No ice']);
  });

  it('returns an empty array for an empty input', () => {
    expect(formatModifierLines([])).toEqual([]);
  });

  it('drops empty/whitespace-only names', () => {
    expect(formatModifierLines(['', '   ', 'Real one'])).toEqual(['  + Real one']);
  });

  it('strips control characters from a modifier name', () => {
    const lines = formatModifierLines(['Extra cheese ']);
    expect(lines).toEqual(['  + Extra cheese']);
  });
});

// ============================================================================
// Property-based tests (SC-3)
// ============================================================================

const arbCategoryName = fc.string({ minLength: 1, maxLength: 12 }).filter(s => s.trim().length > 0);

const arbRow: fc.Arbitrary<Row> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 12 }),
  categoryId: fc.uuid(),
  categoryName: arbCategoryName,
});

describe('groupByCategory properties', () => {
  it('single-category degeneracy: any non-empty array sharing one categoryId/categoryName returns exactly one pass-through group in input order', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        arbCategoryName,
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 20 }),
        (categoryId, categoryName, names) => {
          const rows = names.map(name => row(name, categoryId, categoryName));
          const groups = groupByCategory(rows);
          expect(groups).toHaveLength(1);
          expect(groups[0]?.items).toEqual(rows);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('total conservation: concatenated group items are a permutation of the input, same length, no drops/dupes', () => {
    fc.assert(
      fc.property(fc.array(arbRow, { maxLength: 30 }), rows => {
        const groups = groupByCategory(rows);
        const flat = groups.flatMap(g => g.items);
        expect(flat).toHaveLength(rows.length);
        expect(flat.map(item => JSON.stringify(item)).sort()).toEqual(rows.map(item => JSON.stringify(item)).sort());
      }),
      { numRuns: 200 }
    );
  });

  it('uncategorized-last invariant: at most one categoryId===null group exists and it is always last', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(arbRow, fc.constant(row('uncat', null, null))), { maxLength: 30 }),
        rows => {
          const groups = groupByCategory(rows);
          const nullGroups = groups.filter(g => g.categoryId === null);
          expect(nullGroups.length).toBeLessThanOrEqual(1);
          if (nullGroups.length === 1) {
            expect(groups[groups.length - 1]?.categoryId).toBeNull();
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
