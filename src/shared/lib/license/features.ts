import { useCallback } from 'react';
import { isLicenseEnforced } from './config';
import { useLicenseStore } from './store';
import type { LicensePayload } from './types';
import { useUpgradeDialogStore } from './upgrade-dialog-store';

/** Gate-able capabilities. The license token's `features` array is an allow-list over these. */
export const FEATURE_KEYS = [
  'report_export',
  'ai_assistant',
  'email_receipts',
  'settings_backup',
  'audit_log',
  'edit_history',
  'staff_management',
  'rbac_editing',
  'promotions',
  'purchase_orders',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Pure policy — see spec §3.2. Unknown keys in the allow-list are ignored; missing keys are locked. */
export function isFeatureEnabled(
  key: FeatureKey,
  payload: LicensePayload | null,
  enforced: boolean
): boolean {
  if (!enforced) return true;
  if (!payload) return false;
  const features = payload.features;
  if (features === null || features === undefined) return true;
  return features.includes(key);
}

export function isDemoPlan(payload: LicensePayload | null): boolean {
  return payload?.plan === 'demo';
}

/** Non-hook variant for module-level guards. */
export function isFeatureEnabledNow(key: FeatureKey): boolean {
  return isFeatureEnabled(key, useLicenseStore.getState().payload, isLicenseEnforced());
}

export function useIsDemo(): boolean {
  const payload = useLicenseStore(s => s.payload);
  return isLicenseEnforced() && isDemoPlan(payload);
}

export function useFeature(key: FeatureKey): {
  enabled: boolean;
  locked: boolean;
  requestUpgrade: () => void;
} {
  const payload = useLicenseStore(s => s.payload);
  const openFor = useUpgradeDialogStore(s => s.openFor);
  const enabled = isFeatureEnabled(key, payload, isLicenseEnforced());
  const requestUpgrade = useCallback(() => {
    openFor(key);
  }, [openFor, key]);
  return { enabled, locked: !enabled, requestUpgrade };
}

/** For nav manifests: locked only when the item declares a feature that the license lacks. */
export function useNavFeatureLocked(feature: FeatureKey | undefined): {
  locked: boolean;
  requestUpgrade: () => void;
} {
  const payload = useLicenseStore(s => s.payload);
  const openFor = useUpgradeDialogStore(s => s.openFor);
  const locked = feature !== undefined && !isFeatureEnabled(feature, payload, isLicenseEnforced());
  const requestUpgrade = useCallback(() => {
    if (feature) openFor(feature);
  }, [feature, openFor]);
  return { locked, requestUpgrade };
}
