import { describe, expect, it } from 'vitest';
import { getHelpForRoute } from './content';

describe('getHelpForRoute', () => {
  it('returns exact-match entry for a known route', () => {
    const entry = getHelpForRoute('/inventory');
    expect(entry.title).toMatch(/Inventory/i);
    expect(entry.body).toContain('#');
  });

  it('falls back to the top-level prefix for sub-routes', () => {
    const entry = getHelpForRoute('/staff/abc-123');
    expect(entry.title).toMatch(/Staff/i);
  });

  it('returns a generic fallback for unknown routes', () => {
    const entry = getHelpForRoute('/totally-unknown');
    expect(entry.title).toBe('Help');
  });
});
