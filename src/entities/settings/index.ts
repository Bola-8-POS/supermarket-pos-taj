export { useSettings, useMutationUpdateSetting, useReceiptSettings, useMutationUpdateReceiptSettings, useTerminalLockSettings, useMutationUpdateTerminalLockSettings, useSettingsBackups, useMutationCreateSettingsBackup, useMutationRestoreSettingsBackup, useEmailSettingsStatus, useMutationSendSettingsTestEmail } from './model';

export type { PaymentMethodLabels, ReceiptSettings, TerminalLockSettings } from './model';

// Phase 33 Plan 02: store-logo Storage pipeline — re-exported so pages/login
// and widgets/SettingsTabsPanel can import from @entities/settings.
export {
  ACCEPTED_LOGO_MIME_TYPES,
  MAX_LOGO_UPLOAD_BYTES,
  STORE_BRANDING_BUCKET,
  resizeStoreLogo,
  signStoreLogo,
  storeLogoObjectPath,
  targetLogoDimensions,
  useRemoveStoreLogo,
  useStoreLogoUpload,
  useStoreLogoUrl,
  validateStoreLogoFile,
} from './model';

export type { StoreLogoRemoveInput, StoreLogoUploadInput } from './model';

// Phase 33 Plan 03: login-hero logo component, distinct from the
// receipt-only widgets/LogoImage (33-PLAN.md Task 2).
export { StoreLogoImage } from './ui/StoreLogoImage';
