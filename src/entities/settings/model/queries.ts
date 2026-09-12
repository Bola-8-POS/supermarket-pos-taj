import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStaffStore } from '@entities/staff/model/store';
import {
  callCreateSettingsBackup,
  callRestoreSettingsBackup,
  callSendSettingsTestEmail,
  callSettingsEmailStatus,
} from '@shared/lib/edge-function-contracts';
import { logger } from '@shared/lib/logger-instance';
/* eslint-disable i18next/no-literal-string -- query-key namespace strings +
   settings-table row-key lookups below (Map.get('general') etc.) are internal
   config identifiers, not UI copy. */
import {
  err,
  ok,
  parseSupabaseError,
  supabaseMutation,
  supabaseQuery,
  unknownError,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { Tables, TablesInsert } from '@shared/lib/supabase.types';
import {
  BillingSettingsSchema,
  EmailReceiptSettingsSchema,
  GeneralSettingsSchema,
  NearExpirySettingsSchema,
  PaymentMethodLabelsSchema,
  ReceiptSettingsSchema,
  SettingsBackupSummarySchema,
  type BillingSettings,
  type EmailReceiptSettings,
  type GeneralSettings,
  type NearExpirySettings,
  type PaymentMethodLabels,
  type ReceiptSettings,
  type SettingsBackupSummary,
  type SettingsKey,
  type TerminalLockSettings,
} from './types';

// terminal_lock_settings is not yet in generated supabase.types.ts (Phase 21) —
// scoped `any` per CLAUDE.md's "Missing generated types workaround", mirroring
// the receipt_settings hooks below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
const db = supabase as any;

// D-02/RESEARCH.md correction note: the env-var-reading inline TERMINAL_ID
// pattern (majority precedent, 8 of 11 files) — NOT the hardcoded
// @shared/config/constants import, which never varies per terminal.
/* eslint-disable-next-line i18next/no-literal-string -- env fallback literal, not UI copy */
const TERMINAL_ID = (import.meta.env.VITE_TERMINAL_ID as string | undefined) ?? 'POS-1';

const DEFAULT_GENERAL: GeneralSettings = {
  storeName: '',
  address: '',
  timezone: 'America/Mexico_City',
  currency: 'MXN',
  receiptFooterText: '',
  storeLogoPath: null,
};

const DEFAULT_BILLING: BillingSettings = {
  taxRatePercent: 16,
  paymentMethods: { cash: true, card: true, bank_transfer: true, rappi: true, uber_eats: true },
  taxInclusive: true,
};

const DEFAULT_EMAIL_RECEIPTS: EmailReceiptSettings = {
  fromEmail: '',
};

const DEFAULT_PAYMENT_LABELS: PaymentMethodLabels = {
  cash: 'Efectivo',
  card: 'Terminal',
  bank_transfer: 'Transferencia',
  rappi: 'Rappi',
  uber_eats: 'Uber Eats',
};

const DEFAULT_NEAR_EXPIRY: NearExpirySettings = { thresholdDays: 14, discountPercent: 15 };

const DEFAULT_RECEIPT: ReceiptSettings = {
  paperWidthChars: 32,
  showCashierName: true,
  showCustomerName: true,
  showReceiptNumber: true,
  headerLine2: '',
  footerText: '',
  boldTotals: true,
  printOnStart: false,
  autoCut: false,
  kdsEnabled: false,
  logoDataUrl: null,
  printerName: null,
};

export type SettingsSnapshot = {
  general: GeneralSettings;
  billing: BillingSettings;
  emailReceipts: EmailReceiptSettings;
  paymentLabels: PaymentMethodLabels;
  nearExpiry: NearExpirySettings;
};

const settingsKeys = {
  all: ['settings'] as const,
  backups: () => [...settingsKeys.all, 'backups'] as const,
  emailStatus: () => [...settingsKeys.all, 'email-status'] as const,
};

// receipt_settings is a true one-row singleton (D-04) — every write upserts
// onto this same fixed id rather than a `key` column. Claude's Discretion
// (CONTEXT.md): lowest-risk, most reversible way to enforce "exactly one
// row" without a new schema constraint.
const RECEIPT_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-000000000001';

const receiptSettingsKeys = {
  all: ['receipt_settings'] as const,
};

// terminal_lock_settings is genuinely per-terminal (D-02) — keyed by
// TERMINAL_ID, not a store-wide singleton like receipt_settings.
const DEFAULT_TERMINAL_LOCK: TerminalLockSettings = { lockTimeoutSeconds: 60 };

const terminalLockSettingsKeys = {
  all: ['terminal_lock_settings', TERMINAL_ID] as const,
};

type SettingsRow = Tables<'settings'>;
type SettingsInsert = TablesInsert<'settings'>;

const SETTINGS_KEYS: SettingsKey[] = [
  'general',
  'billing',
  'email_receipts',
  'pool_tables',
  'payment_labels',
  'near_expiry',
];

function parseGeneral(value: unknown): GeneralSettings {
  const parsed = GeneralSettingsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // CR-01: a single invalid field (e.g. a blanked required `address`) must
  // not collapse the whole snapshot to DEFAULT_GENERAL -- toSnapshot() is
  // the single read path shared by every consumer, including the store-logo
  // upload/remove read-merge-write in useStoreLogoUpload.ts, which would
  // otherwise persist DEFAULT_GENERAL's placeholder values back over the
  // real storeName/timezone/currency/receiptFooterText on the next write.
  // Fall back field-by-field instead so one bad field can't erase the rest.
  const raw = (value ?? {}) as Partial<Record<keyof GeneralSettings, unknown>>;
  return {
    storeName: typeof raw.storeName === 'string' ? raw.storeName : DEFAULT_GENERAL.storeName,
    address:
      typeof raw.address === 'string' && raw.address.length > 0 ? raw.address : DEFAULT_GENERAL.address,
    timezone:
      typeof raw.timezone === 'string' && raw.timezone.length > 0
        ? raw.timezone
        : DEFAULT_GENERAL.timezone,
    currency: typeof raw.currency === 'string' ? raw.currency : DEFAULT_GENERAL.currency,
    receiptFooterText:
      typeof raw.receiptFooterText === 'string'
        ? raw.receiptFooterText
        : DEFAULT_GENERAL.receiptFooterText,
    storeLogoPath: typeof raw.storeLogoPath === 'string' ? raw.storeLogoPath : null,
  };
}

function parseBilling(value: unknown): BillingSettings {
  const parsed = BillingSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_BILLING;
}

function parseEmailReceipts(value: unknown): EmailReceiptSettings {
  const parsed = EmailReceiptSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_EMAIL_RECEIPTS;
}

function parsePaymentLabels(value: unknown): PaymentMethodLabels {
  const parsed = PaymentMethodLabelsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PAYMENT_LABELS;
}

function parseReceipt(value: unknown): ReceiptSettings {
  const parsed = ReceiptSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_RECEIPT;
}

// Derived from the generated `receipt_settings` Row type (DATA-03) so a
// future column rename is caught by typecheck instead of silently drifting.
type ReceiptSettingsRow = Pick<
  Tables<'receipt_settings'>,
  | 'paper_width_chars'
  | 'show_cashier_name'
  | 'show_customer_name'
  | 'show_receipt_number'
  | 'header_line_2'
  | 'footer_text'
  | 'bold_totals'
  | 'print_on_start'
  | 'auto_cut'
  | 'kds_enabled'
  | 'logo_data_url'
  | 'printer_name'
>;

function mapReceiptRow(row: ReceiptSettingsRow): ReceiptSettings {
  return parseReceipt({
    paperWidthChars: row.paper_width_chars,
    showCashierName: row.show_cashier_name,
    showCustomerName: row.show_customer_name,
    showReceiptNumber: row.show_receipt_number,
    headerLine2: row.header_line_2,
    footerText: row.footer_text,
    boldTotals: row.bold_totals,
    printOnStart: row.print_on_start,
    autoCut: row.auto_cut,
    kdsEnabled: row.kds_enabled,
    logoDataUrl: row.logo_data_url,
    printerName: row.printer_name,
  });
}

function toReceiptPayload(value: ReceiptSettings): ReceiptSettingsRow {
  return {
    paper_width_chars: value.paperWidthChars,
    show_cashier_name: value.showCashierName,
    show_customer_name: value.showCustomerName,
    show_receipt_number: value.showReceiptNumber,
    header_line_2: value.headerLine2,
    footer_text: value.footerText,
    bold_totals: value.boldTotals,
    print_on_start: value.printOnStart,
    auto_cut: value.autoCut,
    kds_enabled: value.kdsEnabled,
    logo_data_url: value.logoDataUrl,
    printer_name: value.printerName,
  };
}

function parseNearExpiry(value: unknown): NearExpirySettings {
  const parsed = NearExpirySettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_NEAR_EXPIRY;
}

function parseBackup(row: Tables<'settings_backups'>): Result<SettingsBackupSummary> {
  try {
    return ok(
      SettingsBackupSummarySchema.parse({
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
        createdBy: row.created_by,
        restoredAt: row.restored_at,
        restoredBy: row.restored_by,
      })
    );
  } catch (error) {
    return err(unknownError(error));
  }
}

function toSnapshot(rows: SettingsRow[]): SettingsSnapshot {
  const byKey = new Map(rows.map(row => [row.key, row.value] as const));
  const snapshot: SettingsSnapshot = {
    general: parseGeneral(byKey.get('general')),
    billing: parseBilling(byKey.get('billing')),
    emailReceipts: parseEmailReceipts(byKey.get('email_receipts')),
    paymentLabels: parsePaymentLabels(byKey.get('payment_labels')),
    nearExpiry: parseNearExpiry(byKey.get('near_expiry')),
  };
  return snapshot;
}

export function useSettings() {
  const query = useQuery({
    queryKey: settingsKeys.all,
    queryFn: async (): Promise<Result<SettingsSnapshot>> => {
      const res = await supabaseQuery(() =>
        supabase
          .from('settings')
          .select('*')
          .in('key', SETTINGS_KEYS)
          .order('updated_at', { ascending: false })
      );
      if (!res.ok) {
        logger.error('settings.fetch_failed', { message: res.error.message, code: res.error.code });
        return res;
      }

      return ok(toSnapshot(res.data));
    },
    staleTime: 30 * 1000,
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

export function useMutationUpdateSetting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      key,
      value,
    }: {
      key: SettingsKey;
      value:
        | GeneralSettings
        | BillingSettings
        | EmailReceiptSettings
        | PaymentMethodLabels
        | ReceiptSettings
        | NearExpirySettings
        | Record<string, unknown>;
    }): Promise<Result<void>> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const payload: SettingsInsert = {
        key,
        value: value as unknown as TablesInsert<'settings'>['value'],
        updated_by: user?.id ?? null,
      };

      const res = await supabaseMutation(() =>
        supabase.from('settings').upsert(payload, { onConflict: 'key' }).select('id').single()
      );
      if (!res.ok) {
        logger.error('settings.update_failed', {
          key,
          message: res.error.message,
          code: res.error.code,
        });
        return res;
      }
      return ok(undefined);
    },
    onSuccess: result => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      }
    },
  });
}

export function useReceiptSettings() {
  const query = useQuery({
    queryKey: receiptSettingsKeys.all,
    queryFn: async (): Promise<Result<ReceiptSettings>> => {
      // Read directly (NOT via supabaseQuery()): supabaseQuery() treats a null
      // row as a NOT_FOUND error, but an empty receipt_settings table is the
      // legitimate D-06 starting state, not an error.
      const { data, error } = await supabase.from('receipt_settings').select('*').maybeSingle();

      if (error) {
        logger.error('receipt_settings.fetch_failed', { message: error.message, code: error.code });
        return err(parseSupabaseError(error));
      }

      return ok(data ? mapReceiptRow(data) : DEFAULT_RECEIPT);
    },
    staleTime: 30 * 1000,
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

export function useMutationUpdateReceiptSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (value: ReceiptSettings): Promise<Result<void>> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const payload = {
        id: RECEIPT_SETTINGS_SINGLETON_ID,
        ...toReceiptPayload(value),
        updated_by: user?.id ?? null,
      };

      const { error } = await supabase
        .from('receipt_settings')
        .upsert(payload, { onConflict: 'id' })
        .select('id')
        .single();

      if (error) {
        logger.error('receipt_settings.update_failed', { message: error.message, code: error.code });
        return err(parseSupabaseError(error));
      }
      return ok(undefined);
    },
    onSuccess: result => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: receiptSettingsKeys.all });
      }
    },
  });
}

export function useTerminalLockSettings() {
  const isAuthenticated = useStaffStore(s => s.isAuthenticated);
  const query = useQuery({
    queryKey: terminalLockSettingsKeys.all,
    queryFn: async (): Promise<Result<TerminalLockSettings>> => {
      // Read directly (NOT via supabaseQuery()): an empty terminal_lock_settings
      // table (before the first admin save) is a legitimate starting state, not
      // an error — .maybeSingle() lets a null row fall through to the default.
      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- `db`
         is a scoped `any` cast, see comment above its declaration */
      const { data, error } = await db
        .from('terminal_lock_settings')
        .select('lock_timeout_seconds')
        .eq('terminal_id', TERMINAL_ID)
        .maybeSingle();

      if (error) {
        logger.error('terminal_lock_settings.fetch_failed', { message: error.message, code: error.code });
        return err(parseSupabaseError(error));
      }
      /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

      return ok(
        data
          ? { lockTimeoutSeconds: (data as { lock_timeout_seconds: number }).lock_timeout_seconds }
          : DEFAULT_TERMINAL_LOCK
      );
    },
    // Gated on isAuthenticated (Rule 1 fix, Plan 21-02): terminal_lock_settings'
    // SELECT RLS policy is `TO authenticated` -- an ungated query fires once at
    // initial app mount, before login, when the client is still anonymous. RLS
    // silently returns zero rows (no error), and that `null` result gets cached
    // for staleTime with no later invalidation on login, permanently stranding
    // IdleLockProvider on DEFAULT_TERMINAL_LOCK (60s) regardless of the admin's
    // configured per-terminal value -- until a full page reload happens to
    // occur. Gating `enabled` here means the query simply doesn't fire until a
    // real session exists, so its first (and only meaningfully cached) fetch is
    // always authenticated.
    enabled: isAuthenticated,
    staleTime: 30 * 1000,
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

export function useMutationUpdateTerminalLockSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (lockTimeoutSeconds: number): Promise<Result<void>> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- `db`
         is a scoped `any` cast, see comment above its declaration */
      const { error } = await db
        .from('terminal_lock_settings')
        .upsert(
          { terminal_id: TERMINAL_ID, lock_timeout_seconds: lockTimeoutSeconds, updated_by: user?.id ?? null },
          { onConflict: 'terminal_id' }
        )
        .select('terminal_id')
        .single();

      if (error) {
        logger.error('terminal_lock_settings.update_failed', { message: error.message, code: error.code });
        return err(parseSupabaseError(error));
      }
      /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
      return ok(undefined);
    },
    onSuccess: result => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: terminalLockSettingsKeys.all });
      }
    },
  });
}

export function useSettingsBackups() {
  const query = useQuery({
    queryKey: settingsKeys.backups(),
    queryFn: async (): Promise<Result<SettingsBackupSummary[]>> => {
      const res = await supabaseQuery(() =>
        supabase
          .from('settings_backups')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(25)
      );
      if (!res.ok) {
        return res;
      }
      const backups: SettingsBackupSummary[] = [];
      for (const row of res.data) {
        const parsed = parseBackup(row);
        if (!parsed.ok) return parsed;
        backups.push(parsed.data);
      }
      return ok(backups);
    },
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

export function useMutationCreateSettingsBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (label: string) => callCreateSettingsBackup({ label }),
    onSuccess: result => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: settingsKeys.backups() });
      }
    },
  });
}

export function useMutationRestoreSettingsBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ backupId }: { backupId: string }) =>
      callRestoreSettingsBackup({ backupId }),
    onSuccess: result => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
        void queryClient.invalidateQueries({ queryKey: settingsKeys.backups() });
      }
    },
  });
}

export function useEmailSettingsStatus() {
  const query = useQuery({
    queryKey: settingsKeys.emailStatus(),
    queryFn: async () => callSettingsEmailStatus(),
    staleTime: 60 * 1000,
  });
  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

export function useMutationSendSettingsTestEmail() {
  return useMutation({
    mutationFn: async ({ email }: { email: string }) => callSendSettingsTestEmail({ email }),
  });
}
