import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantReply } from '@shared/lib/local-assistant/presenter';
import {
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_MESSAGES,
  pruneHistory,
  useAssistantHistory,
} from './historyStore';

const NOW = 1_800_000_000_000;
const KEY_A = 'pos.assistant.history.staff-a';

const lookup: AssistantReply = { type: 'result', kind: 'product.lookup', rows: [], more: false };
const sales: AssistantReply = {
  type: 'result',
  kind: 'sales.summary',
  summary: { status: 'none' } as never, // shape irrelevant: the store must never look inside a persist:false reply
};

describe('pruneHistory', () => {
  it('keeps at most 50, none older than 7 days, order preserved', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 20 * 24 * 3600 * 1000 }), { maxLength: 120 }), ages => {
        const msgs = ages.map((age, i) => ({ i, createdAt: NOW - age }));
        const out = pruneHistory(msgs, NOW);
        expect(out.length).toBeLessThanOrEqual(HISTORY_MAX_MESSAGES);
        expect(out.every(m => m.createdAt >= NOW - HISTORY_MAX_AGE_MS)).toBe(true);
        const idx = out.map(m => m.i);
        expect(idx).toEqual([...idx].sort((a, b) => a - b));
      })
    );
  });

  it('keeps the newest 50 when more are recent', () => {
    const msgs = Array.from({ length: 60 }, (_, i) => ({ i, createdAt: NOW - 1000 + i }));
    expect(pruneHistory(msgs, NOW).map(m => m.i)).toEqual(Array.from({ length: 50 }, (_, k) => k + 10));
  });
});

describe('useAssistantHistory', () => {
  beforeEach(() => {
    localStorage.clear();
    useAssistantHistory.getState().bind(null);
  });

  it('stores the question and a lookup reply under the staff key, never a persist:false reply', () => {
    const h = useAssistantHistory.getState();
    h.bind('staff-a', NOW);
    h.append({ role: 'user', text: 'price of ghee' }, NOW);
    h.append({ role: 'assistant', reply: lookup }, NOW);
    h.append({ role: 'assistant', reply: sales, persist: false }, NOW);
    const raw = localStorage.getItem(KEY_A) ?? '';
    expect(raw).toContain('price of ghee');
    expect(raw).not.toContain('sales.summary');
    expect(useAssistantHistory.getState().messages).toHaveLength(2);
  });

  it('does not store cards even if they are not flagged', () => {
    const h = useAssistantHistory.getState();
    h.bind('staff-a', NOW);
    h.append({ role: 'assistant', reply: { type: 'outcome', kind: 'product.price', status: 'executed', items: [] } }, NOW);
    h.append({ role: 'assistant', reply: { type: 'choose', kind: 'stock.low', options: [] } }, NOW);
    expect(useAssistantHistory.getState().messages).toHaveLength(0);
  });

  it('gives each staff member only their own history, and a re-bind restores it', () => {
    const h = useAssistantHistory.getState();
    h.bind('staff-a', NOW);
    h.append({ role: 'user', text: 'a question' }, NOW);
    expect(h.bind('staff-b', NOW)).toEqual([]);
    h.append({ role: 'user', text: 'b question' }, NOW);
    const back = h.bind('staff-a', NOW);
    expect(back.map(m => (m.role === 'user' ? m.text : ''))).toEqual(['a question']);
  });

  it('clears memory and writes nothing when signed out', () => {
    const h = useAssistantHistory.getState();
    h.bind('staff-a', NOW);
    h.append({ role: 'user', text: 'a question' }, NOW);
    expect(h.bind(null)).toEqual([]);
    h.append({ role: 'user', text: 'ghost' }, NOW);
    expect(localStorage.getItem(KEY_A)).not.toContain('ghost');
  });

  it('prunes old and malformed stored rows when binding', () => {
    localStorage.setItem(
      KEY_A,
      JSON.stringify({
        state: {
          messages: [
            { role: 'user', text: 'old', createdAt: NOW - HISTORY_MAX_AGE_MS - 1 },
            { role: 'user', text: 'fresh', createdAt: NOW - 1000 },
            { role: 'assistant', reply: { type: 'result', kind: 'sales.summary', summary: {} }, createdAt: NOW },
            { role: 'assistant', reply: 'junk', createdAt: NOW },
          ],
        },
        version: 0,
      })
    );
    const out = useAssistantHistory.getState().bind('staff-a', NOW);
    expect(out.map(m => (m.role === 'user' ? m.text : '?'))).toEqual(['fresh']);
  });
});
