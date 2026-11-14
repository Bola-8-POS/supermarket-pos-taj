import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface LockState {
  locked: boolean;
  setLocked: (locked: boolean) => void;
}

/**
 * Single source of truth for "is the screen currently locked" within this
 * window's JS realm, so any module (e.g. CheckoutPanel's global
 * useBarcodeScanner listener, or shared/ui's ConfirmDialog/WeightEntryDialog
 * global keydown listeners) can read it without prop-drilling from App.tsx
 * down through the FSD layers. Lives in shared/lib (not
 * features/idle-screen-lock) specifically so shared/ui components can depend
 * on it without inverting the FSD import direction (app -> pages -> widgets
 * -> features -> entities -> shared).
 *
 * Persisted (localStorage key `lock-state`) so that quitting the app while the
 * overlay is up and relaunching re-shows the overlay instead of the restored
 * session's route (Supabase session + staff-store are both persisted, so an
 * in-memory flag alone was a PIN bypass: close window → relaunch → unlocked).
 * IdleLockProvider clears a stale `locked` whenever there is no authenticated
 * staff, so a fresh login can never start locked.
 * The Product Peek window hydrates the same key but never writes it and is
 * deliberately not gated on it (see 21-RESEARCH.md Open Question 1).
 */
export const useLockStateStore = create<LockState>()(
  persist(
    set => ({
      locked: false,
      setLocked: locked => {
        set({ locked });
      },
    }),
    {
      name: 'lock-state',
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ locked: state.locked }),
    }
  )
);
