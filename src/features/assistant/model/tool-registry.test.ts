import { describe, expect, it } from 'vitest';
import type { Proposal } from '@shared/lib/local-assistant/proposal';
import { TOOL_REGISTRY, decide } from './tool-registry';

/** One message that holds every value the fixtures below use, so the grounding guard passes them all. */
const SAID = 'price of ghee from Sysco in 7 days, write off 2 ghee, set ghee to 89.50';
const lookup: Proposal = { kind: 'product.lookup', args: { query: 'ghee' } };

describe('decide', () => {
  it('turns a lookup into a read decision without needing any action', () => {
    expect(decide(lookup, () => false, SAID)).toEqual({ type: 'read', kind: 'product.lookup', args: { query: 'ghee' } });
  });

  it('turns expiry.list into a read decision needing no action', () => {
    const p: Proposal = { kind: 'expiry.list', args: { withinDays: 7 } };
    expect(decide(p, () => false, SAID)).toEqual({ type: 'read', kind: 'expiry.list', args: { withinDays: 7 } });
    expect(TOOL_REGISTRY['expiry.list'].action).toBeNull();
  });

  it('turns stock.low into a read decision needing no action', () => {
    const p: Proposal = { kind: 'stock.low', args: { supplierQuery: 'Sysco' } };
    expect(decide(p, () => false, SAID)).toEqual({ type: 'read', kind: 'stock.low', args: { supplierQuery: 'Sysco' } });
    expect(TOOL_REGISTRY['stock.low'].action).toBeNull();
  });

  it('refuses sales.summary with AUTH_FORBIDDEN when the role lacks view_reports, and allows it otherwise', () => {
    const p: Proposal = { kind: 'sales.summary', args: {} };
    expect(TOOL_REGISTRY['sales.summary'].action).toBe('view_reports');
    expect(decide(p, () => false, SAID)).toEqual({ type: 'refuse', code: 'AUTH_FORBIDDEN' });
    expect(decide(p, a => a === 'view_reports', SAID)).toEqual({ type: 'read', kind: 'sales.summary', args: {} });
  });

  it.each([
    ['unsupported', 'MODEL_REFUSED_UNSUPPORTED'],
    ['unsafe', 'MODEL_REFUSED_UNSAFE'],
    ['ambiguous', 'MODEL_REFUSED_AMBIGUOUS'],
  ] as const)('maps refuse/%s to %s', (reason, code) => {
    expect(decide({ kind: 'refuse', reason }, () => true, SAID)).toEqual({ type: 'refuse', code });
  });

  it('turns an invented required arg into a clarification, never a read', () => {
    expect(decide(lookup, () => true, 'show me 10 product prices')).toEqual({ type: 'refuse', code: 'MODEL_REFUSED_AMBIGUOUS' });
  });

  it('drops an invented optional arg and still reads', () => {
    const p: Proposal = { kind: 'stock.low', args: { supplierQuery: 'Sysco' } };
    expect(decide(p, () => true, 'low stock items')).toEqual({ type: 'read', kind: 'stock.low', args: { supplierQuery: null } });
  });

  it('product.list is a read for every role and defaults all filters to null', () => {
    const p: Proposal = { kind: 'product.list', args: { query: 'ghee', limit: 10, sort: null } };
    expect(TOOL_REGISTRY['product.list'].action).toBeNull();
    expect(decide(p, () => false, 'Show me 10 product prices')).toEqual({
      type: 'read',
      kind: 'product.list',
      args: { query: null, limit: 10, sort: null },
    });
  });

  it('sales.recent needs close_tab (the payments RLS gate); view_reports only widens the scope in the gateway', () => {
    const p: Proposal = { kind: 'sales.recent', args: { limit: null } };
    expect(TOOL_REGISTRY['sales.recent'].action).toBe('close_tab');
    expect(decide(p, () => false, 'last payment')).toEqual({ type: 'refuse', code: 'AUTH_FORBIDDEN' });
    expect(decide(p, a => a === 'close_tab', 'ultima venta')).toEqual({ type: 'read', kind: 'sales.recent', args: { limit: null } });
  });

  it('refuses a kind that is not in the registry', () => {
    const rogue = { kind: 'product.delete', args: {} } as unknown as Proposal;
    expect(decide(rogue, () => true, SAID)).toEqual({ type: 'refuse', code: 'MODEL_REFUSED_UNSUPPORTED' });
  });

  it('refuses with AUTH_FORBIDDEN when a registered action is not held', () => {
    const entry = TOOL_REGISTRY['product.lookup'] as { action: string | null };
    const prev = entry.action;
    entry.action = 'view_reports';
    try {
      expect(decide(lookup, () => false, SAID)).toEqual({ type: 'refuse', code: 'AUTH_FORBIDDEN' });
      expect(decide(lookup, a => a === 'view_reports', SAID).type).toBe('read');
    } finally {
      entry.action = prev;
    }
  });

  it('registers exactly two writes, both PIN-gated; inventory.adjust needs adjust_inventory held by the requester, 25 items', () => {
    const writes = Object.values(TOOL_REGISTRY).filter(e => e.access === 'write');
    expect(writes.map(e => e.kind)).toEqual(['inventory.adjust', 'product.price']);
    expect(TOOL_REGISTRY['inventory.adjust']).toMatchObject({
      action: 'adjust_inventory',
      requiresPin: true,
      auditAction: 'assistant.executed',
      maxItems: 25,
    });
  });

  it('turns inventory.adjust into a write decision, or AUTH_FORBIDDEN without adjust_inventory', () => {
    const p: Proposal = { kind: 'inventory.adjust', args: { reason: 'waste', items: [{ query: 'ghee', delta: -2 }] } };
    expect(decide(p, () => false, SAID)).toEqual({ type: 'refuse', code: 'AUTH_FORBIDDEN' });
    expect(decide(p, a => a === 'adjust_inventory', SAID)).toEqual({ type: 'write', ...p });
  });

  it('turns product.price into a write decision gated by manage_products, never by adjust_inventory', () => {
    const p: Proposal = { kind: 'product.price', args: { items: [{ query: 'ghee', priceCents: 8950 }] } };
    expect(TOOL_REGISTRY['product.price']).toMatchObject({ action: 'manage_products', requiresPin: true, maxItems: 25 });
    expect(decide(p, a => a === 'adjust_inventory', SAID)).toEqual({ type: 'refuse', code: 'AUTH_FORBIDDEN' });
    expect(decide(p, a => a === 'manage_products', SAID)).toEqual({ type: 'write', ...p });
  });
});
