/**
 * Thermal receipt printing — Tauri ESC/POS on Windows, browser fallback elsewhere.
 */

import { toast } from 'sonner';
import type { ReceiptSettings } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import i18n from '@shared/lib/i18n';
import { getCurrentLocale } from '@shared/lib/i18n';
import { isLicenseEnforced } from '@shared/lib/license/config';
import { isDemoPlan } from '@shared/lib/license/features';
import { useLicenseStore } from '@shared/lib/license/store';
import { logger } from '@shared/lib/logger-instance';
import { buildThermalReceiptText } from '@shared/lib/receipt-format';
import type { AppError, AppErrorCode, Result } from '@shared/lib/result';
import { ok, err, tauriError } from '@shared/lib/result';

/** Also used by open-product-peek-window/CheckoutPanel to no-op Tauri-only
 * window/event IPC calls when running outside a Tauri runtime (e.g. this
 * project's Playwright suite drives `npm run dev`, a plain browser tab).
 *
 * Checks `__TAURI_INTERNALS__`, not `__TAURI__` — Tauri v2 only injects the
 * latter when `app.withGlobalTauri` is set in tauri.conf.json (off here, and
 * generally not recommended), while `__TAURI_INTERNALS__` is always present
 * in a real Tauri webview regardless of that setting. Checking `__TAURI__`
 * made this return false even inside the real desktop app, silently routing
 * printReceipt/openCashDrawer/printRawText/testPrint to their browser-fallback
 * branches and no-opping the peek window in production. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Bounded retry for a real (local IPC, not networked) printer — a fixed delay
// is sufficient per CONTEXT.md's discretion note (D-03).
const MAX_PRINT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 700;

// Placeholder job id for the non-Tauri (browser) fallback paths — there is
// no durable broker job behind a `window.print()` popup.
const WEB_FALLBACK_JOB_ID = 'web-fallback';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Maps a broker-submission `invoke()` rejection onto the same
 * PRINT_BROKER_UNREACHABLE / PRINT_JOB_REJECTED split `testPrint()`
 * established in Plan 19-01 (D-12): unreachable-within-connect-timeout vs.
 * any other submission failure (auth/payload/persistence).
 */
function mapPrintInvokeError(e: unknown, fallbackMessage: string): AppError {
  const message = e instanceof Error ? e.message : fallbackMessage;
  const code: AppErrorCode = message.includes('broker unreachable')
    ? 'PRINT_BROKER_UNREACHABLE'
    : 'PRINT_JOB_REJECTED';
  return { code, message, raw: e };
}

/**
 * Single shared source of truth (Plan 19-04, D-11) for selecting a print
 * job's failure-class toast copy key — every UI-originated caller
 * (PaymentForm, CajaDashboard, ReceiptPreview, ReprintButton,
 * HardwareSettingsTab) uses this instead of five independent ad-hoc
 * mappings. Returns an i18n key (not translated text); callers pass it
 * through their own `t()`.
 */
export function printJobErrorCopyKey(code: AppErrorCode): string {
  switch (code) {
    case 'PRINT_BROKER_UNREACHABLE':
      return 'common:printJobError.brokerUnreachable';
    case 'PRINT_JOB_REJECTED':
      return 'common:printJobError.rejected';
    default:
      return 'common:printJobError.failed';
  }
}

/** Demo-plan license: whether the printed/previewed receipt should carry the "not a valid receipt" watermark. */
function demoWatermarkNow(): boolean {
  return isLicenseEnforced() && isDemoPlan(useLicenseStore.getState().payload);
}

/**
 * Builds fully-translated (acting staff's locale) receipt lines for Rust
 * `print_receipt`, which only ESC/POS-encodes them (no label strings in Rust).
 */
export function receiptDataToPrinterLines(data: ReceiptData, settings: ReceiptSettings): string[] {
  const locale = getCurrentLocale();
  return buildThermalReceiptText(data, locale, settings, {
    demoWatermark: demoWatermarkNow(),
  }).split('\n');
}

function printReceiptWebFallback(data: ReceiptData, settings: ReceiptSettings): void {
  const text = buildThermalReceiptText(data, getCurrentLocale(), settings, {
    demoWatermark: demoWatermarkNow(),
  });
  const w = window.open('', '_blank', 'noopener,noreferrer,width=400,height=600');
  if (!w) {
    logger.warn('printer.web.fallback', { reason: 'popup_blocked' });
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- minimal print fallback when not in Tauri
  w.document.write(
    `<!DOCTYPE html><html><head><title>Receipt</title></head><body><pre style="font-family:monospace;font-size:11px;">${escapeHtml(
      text
    )}</pre><script>window.onload=function(){window.print();}</script></body></html>`
  );
  w.document.close();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Broker-backed receipt print (Phase 19: Store-Local Durable Printing
 * Service). Returns the broker's durable job id on acceptance, mapped the
 * same way {@link testPrint} maps its error classes. The retry loop below
 * only ever covers the local `invoke()` IPC call to the Rust command layer —
 * broker-side retry (per failure class) happens after durable acceptance,
 * inside the broker itself (Plan 19-05); stacking a second network-level
 * retry here would risk duplicate physical print jobs.
 */
export async function printReceipt(
  data: ReceiptData,
  settings: ReceiptSettings
): Promise<Result<{ jobId: string }>> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const toastId = `print-${data.receiptNumber}`;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_PRINT_ATTEMPTS; attempt++) {
      try {
        const ack = await invoke<{ job_id: string; status: string }>('print_receipt', {
          lines: receiptDataToPrinterLines(data, settings),
          logoDataUrl: settings.logoDataUrl,
          paperWidthChars: settings.paperWidthChars,
          printerName: settings.printerName ?? undefined,
        });
        if (attempt > 1) {
          toast.success(i18n.t('featOrders:printer.printSucceededAfterRetry'), { id: toastId });
        }
        return ok({ jobId: ack.job_id });
      } catch (e) {
        lastError = e;
        logger.warn('printer.receipt.attempt_failed', { attempt, raw: String(e) });
        if (attempt < MAX_PRINT_ATTEMPTS) {
          toast.loading(
            i18n.t('featOrders:printer.retryingPrint', { attempt, max: MAX_PRINT_ATTEMPTS }),
            { id: toastId }
          );
          await delay(RETRY_DELAY_MS);
        }
      }
    }

    toast.error(i18n.t('featOrders:printer.printFailedAfterRetries', { max: MAX_PRINT_ATTEMPTS }), {
      id: toastId,
    });
    return err(mapPrintInvokeError(lastError, 'Print failed'));
  }
  logger.info('printer.receipt.web_fallback', { receiptNumber: data.receiptNumber });
  printReceiptWebFallback(data, settings);
  return ok({ jobId: WEB_FALLBACK_JOB_ID });
}

/**
 * Broker-backed cash-drawer kick (Phase 19). Single attempt, no retry loop —
 * matches the pre-migration shape. See {@link printReceipt} for the
 * error-class mapping this mirrors.
 */
export async function openCashDrawer(
  printerName?: string | null
): Promise<Result<{ jobId: string }>> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const ack = await invoke<{ job_id: string; status: string }>('open_cash_drawer', {
        printerName: printerName ?? undefined,
      });
      return ok({ jobId: ack.job_id });
    } catch (e) {
      return err(mapPrintInvokeError(e, 'Could not open cash drawer'));
    }
  }
  window.alert('Cash drawer is only available when the POS runs in the desktop app (Tauri).');
  return ok({ jobId: WEB_FALLBACK_JOB_ID });
}

/** Options for {@link printRawText}. */
export type PrintRawTextOptions = {
  /** When true, appends ESC/POS full-cut sequence (GS V A NUL) after the text. */
  autoCut: boolean | undefined;
  /** Configured receipt printer name (ReceiptSettings.printerName). */
  printerName: string | null | undefined;
};

/** ESC/POS full-cut command bytes: GS V A NUL */
const ESC_POS_FULL_CUT = '\x1d\x56\x41\x00';

/**
 * Prints arbitrary pre-formatted plain text on the thermal printer.
 * Used for pre-cheques, shift summaries, etc. where no ReceiptData is built.
 * In Tauri: invokes `print_raw_text` Rust command, broker-backed as of
 * Phase 19 (single attempt, no retry loop — same shape as before). Browser
 * fallback: opens a popup with the text for window.print().
 *
 * @param options.autoCut - When true, appends ESC/POS full-cut bytes after the text.
 */
export async function printRawText(
  text: string,
  options?: PrintRawTextOptions
): Promise<Result<{ jobId: string }>> {
  const payload = options?.autoCut === true ? text + ESC_POS_FULL_CUT : text;

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const ack = await invoke<{ job_id: string; status: string }>('print_raw_text', {
        text: payload,
        printerName: options?.printerName ?? undefined,
      });
      return ok({ jobId: ack.job_id });
    } catch (e) {
      logger.warn('printer.raw_text.failed', { raw: String(e) });
      return err(mapPrintInvokeError(e, 'Print failed'));
    }
  }
  // Browser fallback: open popup with pre-formatted text
  const w = window.open('', '_blank', 'noopener,noreferrer,width=400,height=600');
  if (!w) {
    logger.warn('printer.raw_text.popup_blocked');
    return ok({ jobId: WEB_FALLBACK_JOB_ID });
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- minimal print fallback when not in Tauri
  w.document.write(
    `<!DOCTYPE html><html><head><title>Pre-cheque</title></head><body><pre style="font-family:monospace;font-size:11px;">${escapeHtml(
      text
    )}</pre><script>window.onload=function(){window.print();}</` + `script></body></html>`
  );
  w.document.close();
  return ok({ jobId: WEB_FALLBACK_JOB_ID });
}

/**
 * Broker-backed test print (Phase 19: Store-Local Durable Printing Service).
 * Returns the broker's durable job id on acceptance — not proof of physical
 * output (PRN-07). On failure, maps the Rust command's error string onto a
 * broker-specific AppErrorCode: `PRINT_BROKER_UNREACHABLE` when the broker
 * itself couldn't be reached within the connect-timeout window (D-12),
 * `PRINT_JOB_REJECTED` for any other submission failure (auth/payload/
 * persistence).
 */
export async function testPrint(printerName?: string | null): Promise<Result<{ jobId: string }>> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const ack = await invoke<{ job_id: string; status: string }>('test_print', {
        printerName: printerName ?? undefined,
      });
      return ok({ jobId: ack.job_id });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Test print failed';
      const code: AppErrorCode = message.includes('broker unreachable')
        ? 'PRINT_BROKER_UNREACHABLE'
        : 'PRINT_JOB_REJECTED';
      return err({ code, message, raw: e });
    }
  }
  window.alert('Test print is only available in the desktop app (Tauri).');
  return err(tauriError('Test print requires the Tauri desktop app.'));
}
