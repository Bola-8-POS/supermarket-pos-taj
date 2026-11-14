import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CajaSession } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
/* eslint-disable i18next/no-literal-string -- zustand persist store name below
   is a localStorage key, not UI copy. */

interface CajaState {
  /** The currently open caja session, or null if caja is closed. */
  currentCaja: CajaSession | null;
  /** True when a caja session is open and the POS can take orders. */
  isCajaOpen: boolean;
}

interface CajaActions {
  /** Called by useCajaQuery when the current caja is fetched. */
  setCaja: (session: CajaSession | null) => void;
  /** Clears caja state (e.g. after closing). */
  clearCaja: () => void;
}

type CajaStore = CajaState & CajaActions;

export const useCajaStore = create<CajaStore>()(
  persist(
    set => ({
      currentCaja: null,
      isCajaOpen: false,

      setCaja: session => {
        if (session) {
          logger.info('caja.loaded', { cajaId: session.id, status: session.status });
        } else {
          logger.info('caja.no_open_session');
        }
        set({
          currentCaja: session,
          isCajaOpen: session?.status === 'open',
        });
      },

      clearCaja: () => {
        logger.info('caja.cleared');
        set({ currentCaja: null, isCajaOpen: false });
      },
    }),
    {
      name: 'caja',
      partialize: state => ({
        currentCaja: state.currentCaja,
        isCajaOpen: state.isCajaOpen,
      }),
    }
  )
);
