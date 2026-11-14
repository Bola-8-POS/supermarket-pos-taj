import { describe, expect, it } from 'vitest';
import type { Proposal } from '@shared/lib/local-assistant/proposal';
import { TOOL_REGISTRY, decide } from './tool-registry';

const lookup: Proposal = { kind: 'product.lookup', args: { query: 'ghee' } };

describe('decide', () => {
  it('turns a lookup into a read decision without needing any action', () => {
    expect(decide(lookup, () => false)).toEqual({ type: 'read', kind: 'product.lookup', args: { query: 'ghee' } });
  });

  it('turns expiry.list into a read decision needing no action', () => {
    const p: Proposal = { kind: 'expiry.list', args: { withinDays: 7 } };
    expect(decide(p, () => false)).toEqual({ type: 'read', kind: 'expiry.list', args: { withinDays: 7 } });
    expect(TOOL_REGISTRY['expiry.list'].action).toBeNull();
  });

  it('turns stock.low into a read decision needing no action', () => {
    const p: Proposal = { kind: 'stock.low', args: { supplierQuery: 'Sysco' } };
    expect(decide(p, () => false)).toEqual({ type: 'read', kind: 'stock.low', args: { supplierQuery: 'Sysco' } });
    expect(TOOL_REGISTRY['stock.low'].action).toBeNull();
  });

  it('refuses sales.summary with AUTH_FORBIDDEN when the role lacks view_reports, and allows it otherwise', () => {
    const p: Proposal = { kind: 'sales.summary', args: {} };
    expect(TOOL_REGISTRY['sales.summary'].action).toBe('view_reports');
    expect(decide(p, () => false)).toEqual({ type: 'refuse', code: 'AUTH_FORBIDDEN' });
    expect(decide(p, a => a === 'view_reports')).toEqual({ type: 'read', kind: 'sales.summary', args: {} });
  });

  it.each([
    ['unsupported', 'MODEL_REFUSED_UNSUPPORTED'],
    ['unsafe', 'MODEL_REFUSED_UNSAFE'],
    ['ambiguous', 'MODEL_REFUSED_AMBIGUOUS'],
  ] as const)('maps refuse/%s to %s', (reason, code) => {
    expect(decide({ kind: 'refuse', reason }, () => true)).toEqual({ type: 'refuse', code });
  });

  it('refuses a kind that is not in the registry', () => {
    const rogue = { kind: 'product.delete', args: {} } as unknown as Proposal;
    expect(decide(rogue, () => true)).toEqual({ type: 'refuse', code: 'MODEL_REFUSED_UNSUPPORTED' });
  });

  it('refuses with AUTH_FORBIDDEN when a registered action is not held', () => {
    const entry = TOOL_REGISTRY['product.lookup'] as { action: string | null };
    const prev = entry.action;
    entry.action = 'view_reports';
    try {
      expect(decide(lookup, () => false)).toEqual({ type: 'refuse', code: 'AUTH_FORBIDDEN' });
      expect(decide(lookup, a => a === 'view_reports').type).toBe('read');
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
    expect(decide(p, () => false)).toEqual({ type: 'refuse', code: 'AUTH_FORBIDDEN' });
    expect(decide(p, a => a === 'adjust_inventory')).toEqual({ type: 'write', ...p });
  });

  it('turns product.price into a write decision gated by manage_products, never by adjust_inventory', () => {
    const p: Proposal = { kind: 'product.price', args: { items: [{ query: 'ghee', priceCents: 8950 }] } };
    expect(TOOL_REGISTRY['product.price']).toMatchObject({ action: 'manage_products', requiresPin: true, maxItems: 25 });
    expect(decide(p, a => a === 'adjust_inventory')).toEqual({ type: 'refuse', code: 'AUTH_FORBIDDEN' });
    expect(decide(p, a => a === 'manage_products')).toEqual({ type: 'write', ...p });
  });
});
