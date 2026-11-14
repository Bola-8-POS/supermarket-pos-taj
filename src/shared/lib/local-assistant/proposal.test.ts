import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AssistantCodeSchema, parseProposal, proposalJsonSchema } from './proposal';

const lookup = (query: string) => JSON.stringify({ kind: 'product.lookup', args: { query } });

describe('parseProposal', () => {
  it('accepts a valid product lookup', () => {
    expect(parseProposal('{"kind":"product.lookup","args":{"query":"ghee"}}')).toEqual({
      kind: 'product.lookup',
      args: { query: 'ghee' },
    });
  });

  it('accepts a refuse proposal', () => {
    expect(parseProposal('{"kind":"refuse","reason":"unsupported"}')).toEqual({
      kind: 'refuse',
      reason: 'unsupported',
    });
  });

  it('trims the query', () => {
    expect(parseProposal(lookup('  ghee  '))).toEqual({ kind: 'product.lookup', args: { query: 'ghee' } });
  });

  it.each([
    ['extra top-level key', '{"kind":"product.lookup","args":{"query":"ghee"},"extra":1}'],
    ['extra args key', '{"kind":"product.lookup","args":{"query":"ghee","x":1}}'],
    ['unknown kind', '{"kind":"product.delete","args":{"query":"ghee"}}'],
    ['two objects', `${lookup('a')}${lookup('b')}`],
    ['query of 81 chars', lookup('a'.repeat(81))],
    ['empty query', lookup('')],
    ['whitespace-only query', lookup('   ')],
    ['non-JSON', 'the price of ghee is 5'],
    ['refuse with unknown reason', '{"kind":"refuse","reason":"because"}'],
    ['JSON array', '[]'],
    ['JSON null', 'null'],
  ])('returns null for %s', (_name, text) => {
    expect(parseProposal(text)).toBeNull();
  });

  it('accepts expiry.list with withinDays 0..60 or null', () => {
    for (const withinDays of [0, 7, 60, null]) {
      expect(parseProposal(JSON.stringify({ kind: 'expiry.list', args: { withinDays } }))).toEqual({
        kind: 'expiry.list',
        args: { withinDays },
      });
    }
  });

  it.each([
    ['withinDays 61', { kind: 'expiry.list', args: { withinDays: 61 } }],
    ['withinDays -1', { kind: 'expiry.list', args: { withinDays: -1 } }],
    ['withinDays a string', { kind: 'expiry.list', args: { withinDays: '7' } }],
    ['withinDays fractional', { kind: 'expiry.list', args: { withinDays: 1.5 } }],
    ['withinDays missing', { kind: 'expiry.list', args: {} }],
    ['an extra args key', { kind: 'expiry.list', args: { withinDays: 7, x: 1 } }],
  ])('returns null for expiry.list with %s', (_name, value) => {
    expect(parseProposal(JSON.stringify(value))).toBeNull();
  });

  it('accepts stock.low with a supplier query or null, and sales.summary with empty args', () => {
    for (const supplierQuery of ['Sysco', null]) {
      expect(parseProposal(JSON.stringify({ kind: 'stock.low', args: { supplierQuery } }))).toEqual({
        kind: 'stock.low',
        args: { supplierQuery },
      });
    }
    expect(parseProposal('{"kind":"sales.summary","args":{}}')).toEqual({ kind: 'sales.summary', args: {} });
  });

  it.each([
    ['stock.low with an 81-char supplier', { kind: 'stock.low', args: { supplierQuery: 'a'.repeat(81) } }],
    ['stock.low with an empty supplier', { kind: 'stock.low', args: { supplierQuery: '' } }],
    ['stock.low with an extra key', { kind: 'stock.low', args: { supplierQuery: null, x: 1 } }],
    ['stock.low with the key missing', { kind: 'stock.low', args: {} }],
    ['sales.summary with an extra args key', { kind: 'sales.summary', args: { terminal: 'POS-1' } }],
    ['sales.summary with an extra top-level key', { kind: 'sales.summary', args: {}, x: 1 }],
  ])('returns null for %s', (_name, value) => {
    expect(parseProposal(JSON.stringify(value))).toBeNull();
  });

  it('accepts a query of exactly 80 chars', () => {
    expect(parseProposal(lookup('a'.repeat(80)))).not.toBeNull();
  });

  it('property: any arbitrary string that is not a valid proposal yields null', () => {
    fc.assert(
      fc.property(fc.string(), text => {
        return parseProposal(text) === null;
      })
    );
  });

  it('property: arbitrary JSON values (a valid proposal is vanishingly unlikely) yield null', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        return parseProposal(JSON.stringify(value)) === null;
      })
    );
  });
});

describe('inventory.adjust proposal', () => {
  const batch = (n: number, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      kind: 'inventory.adjust',
      args: { reason: 'waste', items: Array.from({ length: n }, (_v, i) => ({ query: `item ${i}`, delta: -1, ...over })) },
    });

  it('accepts 25 items and refuses 26 or none (D-09)', () => {
    expect(parseProposal(batch(25))).not.toBeNull();
    expect(parseProposal(batch(26))).toBeNull();
    expect(parseProposal(batch(0))).toBeNull();
  });

  it.each([
    ['zero delta', batch(1, { delta: 0 })],
    ['fractional delta', batch(1, { delta: 1.5 })],
    ['delta beyond 9999', batch(1, { delta: 10000 })],
    ['empty query', batch(1, { query: '' })],
    ['unknown reason', batch(1).replace('waste', 'theft')],
    ['an id instead of a name', batch(1, { product_id: '11111111-1111-4111-8111-111111111111' })],
  ])('returns null for %s', (_name, text) => {
    expect(parseProposal(text)).toBeNull();
  });
});

describe('product.price proposal', () => {
  const price = (n: number, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      kind: 'product.price',
      args: { items: Array.from({ length: n }, (_v, i) => ({ query: `item ${i}`, priceCents: 8950, ...over })) },
    });

  it('accepts 1 to 25 items and refuses 26 or none', () => {
    expect(parseProposal(price(1))).toEqual({
      kind: 'product.price',
      args: { items: [{ query: 'item 0', priceCents: 8950 }] },
    });
    expect(parseProposal(price(25))).not.toBeNull();
    expect(parseProposal(price(26))).toBeNull();
    expect(parseProposal(price(0))).toBeNull();
  });

  it.each([
    ['priceCents 0', price(1, { priceCents: 0 })],
    ['a negative price', price(1, { priceCents: -5 })],
    ['a float price', price(1, { priceCents: 89.5 })],
    ['a price above 100000.00', price(1, { priceCents: 10_000_001 })],
    ['a price as a string', price(1, { priceCents: '8950' })],
    ['an empty query', price(1, { query: '' })],
    ['an id instead of a name', price(1, { product_id: '11111111-1111-4111-8111-111111111111' })],
  ])('returns null for %s', (_name, text) => {
    expect(parseProposal(text)).toBeNull();
  });

  it('accepts the highest price the server accepts', () => {
    expect(parseProposal(price(1, { priceCents: 10_000_000 }))).not.toBeNull();
  });
});

describe('proposalJsonSchema', () => {
  it('contains no $ref, format or pattern keys and is closed on every object', () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => { walk(v, `${path}[${i}]`); });
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      for (const banned of ['$ref', 'format', 'pattern']) {
        if (banned in obj) offenders.push(`${path}.${banned}`);
      }
      if (obj['type'] === 'object' && obj['additionalProperties'] !== false) {
        offenders.push(`${path}: additionalProperties not false`);
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
    };
    walk(proposalJsonSchema, '$');
    expect(offenders).toEqual([]);
  });

  it('matches the committed review snapshot', () => {
    expect(JSON.stringify(proposalJsonSchema, null, 2)).toMatchSnapshot();
  });
});

describe('AssistantCodeSchema', () => {
  it('includes the codes this plan uses', () => {
    for (const code of ['INVALID_PROPOSAL', 'INPUT_TOO_LONG', 'PAYMENT_DATA', 'MODEL_TIMEOUT', 'DATA_UNAVAILABLE']) {
      expect(AssistantCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});
