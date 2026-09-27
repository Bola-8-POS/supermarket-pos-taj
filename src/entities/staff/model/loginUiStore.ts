import { create } from 'zustand';
import type { Staff } from '@shared/lib/domain';

/**
 * Ephemeral UI state for the PIN login screen only (which row was tapped).
 * Session identity and shift live on {@link useStaffStore}; do not duplicate them here.
 */
type LoginUiState = {
  selectedStaff: Staff | null;
  setSelectedStaff: (staff: Staff | null) => void;
  clearSelection: () => void;
};

export const useLoginUiStore = create<LoginUiState>(set => ({
  selectedStaff: null,
  setSelectedStaff: staff => {
    set({ selectedStaff: staff });
  },
  clearSelection: () => {
    set({ selectedStaff: null });
  },
}));
