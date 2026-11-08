import { create } from 'zustand';
import type { FeatureKey } from './features';

interface UpgradeDialogState {
  open: boolean;
  /** Which locked feature the user tapped, for the "«X» is available in the full version" line. */
  feature: FeatureKey | null;
  openFor: (feature?: FeatureKey) => void;
  close: () => void;
}

/** Lives in shared/lib so shared/ui (LockedFeature) can open the dialog mounted from features/. */
export const useUpgradeDialogStore = create<UpgradeDialogState>(set => ({
  open: false,
  feature: null,
  openFor: feature => {
    set({ open: true, feature: feature ?? null });
  },
  close: () => {
    set({ open: false, feature: null });
  },
}));
