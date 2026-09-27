/* eslint-disable @typescript-eslint/no-unsafe-argument, react-refresh/only-export-components */
import { Document, Page, Text, StyleSheet, pdf } from '@react-pdf/renderer';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import React from 'react';
import type { ReceiptSettings } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { getCurrentLocale } from '@shared/lib/i18n';
import type { BuildThermalReceiptTextOptions } from '@shared/lib/receipt-format';
import { buildThermalReceiptText } from '@shared/lib/receipt-format';
import { ok, err, exportCancelledError, exportFailedError, type Result } from '@shared/lib/result';

// Courier = monospace, matches buildThermalReceiptText's fixed-width column
// math — deliberately NOT Helvetica, which every other pdf.tsx report doc uses.
const styles = StyleSheet.create({
  page: { padding: 24, fontSize: 9, fontFamily: 'Courier' },
});

/** ONE Text node wrapping buildThermalReceiptText's exact string output — no View, no per-line/per-field elements (D-05). */
function ReceiptDoc({ text }: { text: string }) {
  return React.createElement(
    Document,
    null,
    React.createElement(Page, { size: 'A4', style: styles.page }, React.createElement(Text, null, text))
  );
}

async function docToBytes(doc: React.ReactElement): Promise<Uint8Array> {
  // pdf() accepts React elements that render a Document — cast needed because
  // @react-pdf/renderer's TS signature is narrower than the actual runtime API.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = await pdf(doc as any).toBlob();
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

/** Wraps `buildThermalReceiptText`'s exact output in one monospace PDF `<Text>` node (D-05). */
export async function receiptToPdfBytes(
  receipt: ReceiptData,
  settings: ReceiptSettings,
  opts: BuildThermalReceiptTextOptions = { demoWatermark: false }
): Promise<Uint8Array> {
  const text = buildThermalReceiptText(receipt, getCurrentLocale(), settings, opts);
  return docToBytes(React.createElement(ReceiptDoc, { text }));
}

const BASE64_CHUNK_SIZE = 8192;

/**
 * Base64-encodes bytes via a chunked `String.fromCharCode` reducer — a plain
 * spread `String.fromCharCode(...bytes)` risks a call-stack overflow on large
 * arrays, so chunk it even though a single-page receipt PDF is small.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Downloads a completed sale's receipt as a PDF via the native Tauri save dialog (mirrors useExportReport.ts's save/writeFile sequence). */
export async function downloadReceiptPdf(
  receipt: ReceiptData,
  settings: ReceiptSettings,
  opts: BuildThermalReceiptTextOptions = { demoWatermark: false }
): Promise<Result<void>> {
  try {
    const bytes = await receiptToPdfBytes(receipt, settings, opts);

    const filePath = await save({
      defaultPath: `receipt-${receipt.receiptNumber}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });

    if (filePath === null) {
      return err(exportCancelledError());
    }

    await writeFile(filePath, bytes);

    return ok(undefined);
  } catch (e) {
    return err(exportFailedError(undefined, e));
  }
}
