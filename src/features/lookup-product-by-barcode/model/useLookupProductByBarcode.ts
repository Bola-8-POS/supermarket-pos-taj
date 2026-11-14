import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { mapProductRow, type ProductRow } from '@entities/product/model/queries';
import { isOnline, probeReachability } from '@shared/lib/connectivity';
import type { Product } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { err, networkOfflineError, ok, parseSupabaseError, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';

// Ported from the now-removed useScanBarcodeToCart.ts (Phase 18 rewired
// CheckoutPanel to open the peek window instead of that hook) — a genuinely
// unmatched barcode is still a loss-prevention/traceability event worth
// auditing, regardless of which UI surfaced the lookup.
async function auditScanFailed(code: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_audit', {
      p_action: 'barcode.scan_failed',
      p_entity_type: 'product',
      p_entity_id: null,
      p_before: { barcode: code },
      p_after: null,
      p_terminal_id: getTerminalId(),
      p_user_id: null,
    } as never);
    if (error) logger.warn('barcode_scan.audit_failed', { barcode: code, message: error.message });
  } catch (auditError) {
    logger.warn('barcode_scan.audit_threw', { barcode: code, error: auditError });
  }
}

export function useLookupProductByBarcode() {
  const queryClient = useQueryClient();

  const findCached = useCallback(
    (code: string): Product | null => {
      // useProducts() caches a Result, not a bare array.
      // eslint-disable-next-line i18next/no-literal-string -- TanStack Query cache key, not UI copy
      const cached = queryClient.getQueryData<Result<Product[]> | undefined>(['products']);
      return cached?.ok ? (cached.data.find(p => p.barcode === code) ?? null) : null;
    },
    [queryClient]
  );

  const lookup = useCallback(
    async (code: string): Promise<Result<Product | null>> => {
      // Online, the server is the source of truth: the peek window restores the
      // catalog once and never refetches it, so its copy can be a session old.
      // Offline, the cached catalog is all there is; an unknown barcode offline is
      // not evidence of a missing product (no scan-failed audit).
      const cached = findCached(code);
      const offlineResult = (): Result<Product | null> =>
        cached ? ok(cached) : err(networkOfflineError());
      if (!isOnline()) return offlineResult();

      const { data, error } = await supabase
        .from('products')
        .select(
          `
            *,
            category:categories(*),
            product_modifiers(
              modifier:modifiers(*)
            ),
            inventory(quantity_on_hand, low_stock_threshold)
          ` as never
        )
        // eslint-disable-next-line i18next/no-literal-string -- DB column name, not UI copy
        .eq('barcode' as never, code)
        // A deactivated product's barcode must not be sellable via the
        // cache-miss fallback (T-02-08-02) — findCached() above only ever
        // holds active products since useProducts() filters is_active=true,
        // but a fresh barcode not yet in that cache would otherwise still
        // resolve to an inactive row here.
        .eq('is_active', true)
        .maybeSingle();
      if (error) {
        logger.error('barcode_lookup.failed', { code: error.code, message: error.message });
        // WAN down before the connectivity monitor noticed: treat as offline.
        if (!(await probeReachability())) return offlineResult();
        return err(parseSupabaseError(error));
      }
      if (!data) {
        void auditScanFailed(code);
        return ok(null);
      }
      const mapped = mapProductRow(data as unknown as ProductRow);
      if (!mapped.ok) {
        logger.error('barcode_lookup.map_failed', { message: mapped.error.message });
        return mapped;
      }
      return ok(mapped.data);
    },
    [findCached]
  );

  return { lookup };
}
