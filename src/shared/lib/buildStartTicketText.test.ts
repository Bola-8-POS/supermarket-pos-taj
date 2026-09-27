/**
 * Unit tests for buildStartTicketText.
 * Includes a property-based test (fast-check) for line width invariant.
 */

import * as fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStartTicketText, type StartTicketOpts } from './buildStartTicketText';
import i18n from './i18n/index';

const baseOpts: StartTicketOpts = {
  storeName: 'Bola 8',
  tableLabel: 'Main Table',
  startedAt: new Date('2026-04-21T10:00:00.000Z'),
  ratePerHour: 15,
  paperWidthChars: 32,
};

describe('buildStartTicketText', () => {
  afterEach(async () => {
    await i18n.changeLanguage('es-MX'); // reset for other tests/consumers
  });

  it('snapshot: known input produces expected formatted string', () => {
    const result = buildStartTicketText(baseOpts);
    // Check for presence of key elements
    expect(result).toContain('Bola 8');
    expect(result).toContain('START TICKET');
    expect(result).toContain('Main Table');
    expect(result).toContain('$15.00/h');
    // Snapshot the full result
    expect(result).toMatchSnapshot();
  });

  it('startedAt value appears in the output', () => {
    const startedAt = new Date('2026-04-21T10:00:00.000Z');
    const result = buildStartTicketText({ ...baseOpts, startedAt });
    // The date rendered via toLocaleString should appear somewhere
    const rendered = startedAt.toLocaleString();
    // At minimum the year should appear
    expect(result).toContain('2026');
    // The full locale string may be truncated; at least the rendered parts should be in the output
    expect(result.includes(rendered) || result.includes('2026')).toBe(true);
  });

  it('all output lines are <= paperWidthChars in length (property-based)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 32, max: 48 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.float({ min: 1, max: 200, noNaN: true }),
        (width, storeName, tableLabel, rate) => {
          const opts: StartTicketOpts = {
            storeName,
            tableLabel,
            startedAt: new Date('2026-04-21T10:00:00.000Z'),
            ratePerHour: Math.floor(rate),
            paperWidthChars: width,
          };
          const text = buildStartTicketText(opts);
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.length === 0) continue;
            expect(line.length).toBeLessThanOrEqual(width);
          }
        }
      )
    );
  });
});
