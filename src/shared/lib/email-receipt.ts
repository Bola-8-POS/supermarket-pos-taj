import type { ReceiptSettings } from '@shared/lib/domain';
import { callSendReceiptEmail, type ReceiptData } from '@shared/lib/edge-function-contracts';
import { ReceiptEmailSchema } from '@shared/lib/email-schema';
import { receiptToPdfBytes, uint8ArrayToBase64 } from '@shared/lib/exporters/receipt-pdf';
import { getCurrentLocale } from '@shared/lib/i18n';
import { isLicenseEnforced } from '@shared/lib/license/config';
import { isDemoPlan } from '@shared/lib/license/features';
import { useLicenseStore } from '@shared/lib/license/store';
import { buildThermalReceiptText } from '@shared/lib/receipt-format';
import type { Result } from '@shared/lib/result';
import { err, ok } from '@shared/lib/result';
import type { AppError } from '@shared/lib/supabase-contracts';

/**
 * Sends the plain-text receipt (same layout as print preview) via Resend (edge function),
 * with a PDF attachment when client-side PDF generation succeeds. A PDF-generation
 * failure never blocks the send — the email still goes out plain-text-only and the
 * caller learns of the omission via `pdfAttached: false`.
 */
export async function sendReceiptByEmail(
  data: ReceiptData,
  email: string,
  settings: ReceiptSettings
): Promise<Result<{ pdfAttached: boolean }, AppError>> {
  const parsed = ReceiptEmailSchema.safeParse(email);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'Enter a valid email address';
    return err({ code: 'VALIDATION_ERROR', message: msg });
  }

  const demoWatermark = isLicenseEnforced() && isDemoPlan(useLicenseStore.getState().payload);

  let pdfBase64: string | undefined;
  try {
    pdfBase64 = uint8ArrayToBase64(await receiptToPdfBytes(data, settings, { demoWatermark }));
  } catch {
    pdfBase64 = undefined;
  }

  const result = await callSendReceiptEmail({
    email: parsed.data,
    receiptPlainText: buildThermalReceiptText(data, getCurrentLocale(), settings, {
      demoWatermark,
    }),
    ...(pdfBase64 !== undefined ? { pdfBase64 } : {}),
  });

  if (!result.ok) {
    return result;
  }

  return ok({ pdfAttached: pdfBase64 !== undefined });
}
