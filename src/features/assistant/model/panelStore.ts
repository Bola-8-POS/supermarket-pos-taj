import { create } from 'zustand';
import type { AssistantReply } from '@shared/lib/local-assistant/presenter';
import { useAssistantHistory, type StoredMessage } from './historyStore';

/** Replies are stored as typed data and translated at render time, so a language change re-renders them. */
export type PanelMessage =
  | { id: number; role: 'user'; text: string }
  /** `persist: false` marks money data (the sales summary) and staged writes, which the per-staff history never stores (D-19). */
  | { id: number; role: 'assistant'; reply: AssistantReply; persist?: false };

type DistributiveOmitId<T> = T extends unknown ? Omit<T, 'id'> : never;

interface PanelState {
  isOpen: boolean;
  isBusy: boolean;
  messages: PanelMessage[];
  /** The assistant cool-down (D-15): when it ends (ISO), or null when the assistant is available. */
  lockedUntil: string | null;
  setLockedUntil: (until: string | null) => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setBusy: (busy: boolean) => void;
  addMessage: (msg: DistributiveOmitId<PanelMessage>) => void;
  /** Swaps one assistant message for its follow-up (a preview becomes its outcome), keeping its place in the chat. */
  replaceReply: (id: number, reply: AssistantReply) => void;
  /** Puts a staff member's stored history back at the top of an empty chat (sign-in). */
  restoreMessages: (stored: readonly StoredMessage[]) => void;
  clearMessages: () => void;
}

let nextId = 1;

// Messages live here; the storable subset is mirrored into useAssistantHistory (per staff, D-19).
export const useAssistantPanelStore = create<PanelState>()(set => ({
  isOpen: false,
  isBusy: false,
  messages: [],
  lockedUntil: null,
  setLockedUntil: until => { set({ lockedUntil: until }); },
  open: () => { set({ isOpen: true }); },
  close: () => { set({ isOpen: false }); },
  toggle: () => { set(s => ({ isOpen: !s.isOpen })); },
  setBusy: busy => { set({ isBusy: busy }); },
  addMessage: msg => {
    set(s => ({ messages: [...s.messages, { ...msg, id: nextId++ } as PanelMessage] }));
    useAssistantHistory.getState().append(msg);
  },
  replaceReply: (id, reply) => {
    set(s => ({
      messages: s.messages.map(m => (m.id === id && m.role === 'assistant' ? { ...m, reply, persist: false as const } : m)),
    }));
  },
  restoreMessages: stored => {
    set({ messages: stored.map(({ createdAt: _at, ...m }) => ({ ...m, id: nextId++ }) as PanelMessage) });
  },
  clearMessages: () => { set({ messages: [], lockedUntil: null }); },
}));
