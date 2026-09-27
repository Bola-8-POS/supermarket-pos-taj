import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sanitizeSearch } from './queries';

describe('sanitizeSearch', () => {
  it('strips commas and periods from a search term (PostgREST .or() metacharacters)', () => {
    expect(sanitizeSearch('a,b.c')).not.toContain(',');
    expect(sanitizeSearch('a,b.c')).not.toContain('.');
    expect(sanitizeSearch('a,b.c')).toBe('abc');
  });

  it('leaves a benign search term untouched', () => {
    expect(sanitizeSearch('budweiser')).toBe('budweiser');
  });

  it('strips parentheses (which also have meaning in .or() grouping)', () => {
    expect(sanitizeSearch('or(x,y)')).toBe('orxy');
  });

  it('property: no input produces a string containing , . ( or )', () => {
    fc.assert(
      fc.property(fc.string(), raw => {
        const cleaned = sanitizeSearch(raw);
        expect(cleaned).not.toMatch(/[,.()]/);
      }),
    );
  });
});
