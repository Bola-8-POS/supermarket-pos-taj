import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  AssistantReply,
  ExpiryReply,
  LookupReply,
  ProductListReply,
  LowStockReply,
  RefusalReply,
} from '@shared/lib/local-assistant/presenter';

/* eslint-disable i18next/no-literal-string -- storage keys and discriminants below are not UI copy */

/** D-19: at most the newest 50 messages, none older than 7 days. */
export const HISTORY_MAX_MESSAGES = 50;
export const HISTORY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** WebView localStorage key prefix; the staff id is appended (D-19: plain app storage, no extra encryption). */
const STORAGE_PREFIX = 'pos.assistant.history.';

/** Typed presenter input (never model text), translated at render time. Money data and live action cards are not stored. */
export type PersistedReply = LookupReply | ProductListReply | ExpiryReply | LowStockReply | RefusalReply;

export type StoredMessage = (
  | { role: 'user'; text: string }
  | { role: 'assistant'; reply: PersistedReply }
) & { createdAt: number };

/** What the panel hands over: any panel message minus its id. */
export type HistoryInput =
  | { role: 'user'; text: string }
  | { role: 'assistant'; reply: AssistantReply; persist?: false };

/** Newest 50 within 7 days, order preserved. */
export function pruneHistory<T extends { createdAt: number }>(messages: readonly T[], now: number): T[] {
  return messages.filter(m => m.createdAt >= now - HISTORY_MAX_AGE_MS).slice(-HISTORY_MAX_MESSAGES);
}

function persistableReply(reply: AssistantReply): reply is PersistedReply {
  if (reply.type === 'refusal') return reply.code !== 'ASSISTANT_LOCKED';
  // Money data (sales.summary, sales.recent) is never stored (D-19).
  return reply.type === 'result' && reply.kind !== 'sales.summary' && reply.kind !== 'sales.recent';
}

/** A message may be stored unless it is flagged `persist: false` or is a card (preview, choice, outcome, supplier pick). */
export function toStored(msg: HistoryInput, now: number): StoredMessage | null {
  if (msg.role === 'user') return { role: 'user', text: msg.text, createdAt: now };
  if (msg.persist === false || !persistableReply(msg.reply)) return null;
  return { role: 'assistant', reply: msg.reply, createdAt: now };
}

/** localStorage is plain text on the till: drop anything that is not the shape we wrote. */
function isStored(m: unknown): m is StoredMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  if (typeof r['createdAt'] !== 'number') return false;
  if (r['role'] === 'user') return typeof r['text'] === 'string';
  const reply = r['reply'] as { type?: unknown; kind?: unknown; code?: unknown; rows?: unknown } | undefined;
  if (r['role'] !== 'assistant' || typeof reply !== 'object') return false;
  if (reply.type === 'refusal') return typeof reply.code === 'string';
  return reply.type === 'result' && reply.kind !== 'sales.summary' && reply.kind !== 'sales.recent' && Array.isArray(reply.rows);
}

// The one storage key follows the signed-in staff member; no staff, no key.
let activeStaffId: string | null = null;
const keyOf = (): string | null => (activeStaffId ? `${STORAGE_PREFIX}${activeStaffId}` : null);

interface HistoryState {
  messages: StoredMessage[];
  /** Switch to a staff member (or none): loads and prunes their stored history and returns it. */
  bind: (staffId: string | null | undefined, now?: number) => StoredMessage[];
  append: (msg: HistoryInput, now?: number) => void;
  /** Re-applies the 50 / 7-day cap (called when the panel opens). */
  prune: (now?: number) => void;
}

export const useAssistantHistory = create<HistoryState>()(
  persist(
    (set, get) => ({
      messages: [],
      bind: (staffId, now = Date.now()) => {
        // Park the key first so clearing the previous user's messages never writes to anyone's storage.
        activeStaffId = null;
        set({ messages: [] });
        activeStaffId = staffId ?? null;
        if (activeStaffId === null) return [];
        void useAssistantHistory.persist.rehydrate();
        set({ messages: pruneHistory(get().messages.filter(isStored), now) });
        return get().messages;
      },
      append: (msg, now = Date.now()) => {
        const stored = toStored(msg, now);
        if (stored) set({ messages: pruneHistory([...get().messages, stored], now) });
      },
      prune: (now = Date.now()) => {
        set({ messages: pruneHistory(get().messages, now) });
      },
    }),
    {
      name: STORAGE_PREFIX,
      skipHydration: true,
      partialize: s => ({ messages: s.messages }),
      storage: createJSONStorage(() => ({
        getItem: () => {
          const k = keyOf();
          return k ? localStorage.getItem(k) : null;
        },
        setItem: (_name, value) => {
          const k = keyOf();
          if (k) localStorage.setItem(k, value);
        },
        removeItem: () => {
          const k = keyOf();
          if (k) localStorage.removeItem(k);
        },
      })),
    }
  )
);
