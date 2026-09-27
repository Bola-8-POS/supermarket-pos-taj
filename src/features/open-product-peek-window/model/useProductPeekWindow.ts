import { emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { Product } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { isTauri } from '@shared/lib/pos-printer';

export const PEEK_WINDOW_LABEL = 'peek';
export const BARCODE_SCANNED_EVENT = 'barcode-scanned';
export const ADD_TO_CART_EVENT = 'add-to-cart';
// Distinct from BARCODE_SCANNED_EVENT (which the peek window emits TO the
// main window to sync its search box) — this is the opposite direction, main
// window telling an already-open peek window to refresh. A single shared
// event name would make ProductPeekWindow's own listen() catch its own scan
// relay if Tauri's global emit() self-delivers to the sender (CR-01 fix).
export const PEEK_WINDOW_REFRESH_EVENT = 'peek-window-refresh';

export interface BarcodeScannedPayload {
  code: string;
}

export interface AddToCartPayload {
  product: Product;
  qty?: number;
  weightGrams?: number;
}

/**
 * Opens the "peek" window on the first scan, or reuses it (show + focus +
 * relay) on every subsequent scan while it already exists — never
 * constructs a second WebviewWindow with the same label (Pitfall 4).
 *
 * The very first barcode is delivered via the creation URL's query string,
 * not a post-creation emit(), because the new window's JS hasn't mounted
 * (and therefore hasn't called listen()) by the time the constructor
 * returns — an immediate emit() would race the bootstrap and be lost
 * (RESEARCH.md Pattern 1 / Pitfall 1).
 */
export async function ensurePeekWindowShown(code: string): Promise<void> {
  // No-op outside a real Tauri runtime (e.g. this project's Playwright suite
  // drives `npm run dev`, a plain browser tab with no `WebviewWindow`/IPC
  // bridge) — calling any of these APIs there throws (`window.__TAURI_INTERNALS__`
  // is undefined), which every barcode-scan E2E test would otherwise hit on
  // every scan/mount. The peek-window E2E spec explicitly injects the same
  // `window.__TAURI_INTERNALS__` global isTauri() checks for, so real coverage
  // is unaffected.
  if (!isTauri()) return;
  const existing = await WebviewWindow.getByLabel(PEEK_WINDOW_LABEL);
  if (existing === null) {
    new WebviewWindow(PEEK_WINDOW_LABEL, {
      url: `/?window=peek&barcode=${encodeURIComponent(code)}`,
      title: i18n.t('wPanels:productPeekPanel.windowTitle'),
      width: 480,
      height: 720,
      minWidth: 400,
      minHeight: 600,
      resizable: true,
      center: true,
    });
    return;
  }
  await existing.show();
  await existing.setFocus();
  await emit(PEEK_WINDOW_REFRESH_EVENT, { code });
}
