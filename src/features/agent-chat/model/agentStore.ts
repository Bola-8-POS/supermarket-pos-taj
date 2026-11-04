import { create } from 'zustand';
import type { Message, PendingConfirmation } from '@shared/lib/agent/brain';

interface AgentState {
  isOpen: boolean;
  messages: Message[];
  isTyping: boolean;
  awaitingConfirmation: boolean;
  hasUnread: boolean;
  pendingImportProducts: Array<{ name: string; price: number }> | null;
  pendingConfirmation: PendingConfirmation | null;
}

interface AgentActions {
  open: () => void;
  close: () => void;
  toggle: () => void;
  addMessage: (msg: Message) => void;
  setTyping: (v: boolean) => void;
  setAwaitingConfirmation: (v: boolean) => void;
  markRead: () => void;
  clearMessages: () => void;
  setPendingImportProducts: (products: Array<{ name: string; price: number }> | null) => void;
  setPendingConfirmation: (pending: PendingConfirmation | null) => void;
}

type AgentStore = AgentState & AgentActions;

export const useAgentStore = create<AgentStore>()((set) => ({
  isOpen: false,
  messages: [],
  isTyping: false,
  awaitingConfirmation: false,
  hasUnread: false,
  pendingImportProducts: null,
  pendingConfirmation: null,

  open: () => { set({ isOpen: true, hasUnread: false }); },
  close: () => { set({ isOpen: false }); },
  toggle: () => {
    set((state) => ({
      isOpen: !state.isOpen,
      hasUnread: state.isOpen ? state.hasUnread : false,
    }));
  },
  addMessage: (msg: Message) => { set((state) => ({ messages: [...state.messages, msg] })); },
  setTyping: (v: boolean) => { set({ isTyping: v }); },
  setAwaitingConfirmation: (v: boolean) => { set({ awaitingConfirmation: v }); },
  markRead: () => { set({ hasUnread: false }); },
  clearMessages: () => { set({ messages: [] }); },
  setPendingImportProducts: (products) => { set({ pendingImportProducts: products }); },
  setPendingConfirmation: (pending) => { set({ pendingConfirmation: pending }); },
}));
