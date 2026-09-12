import type { Locale, ReceiptSettings } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { formatMoneyIn } from '@shared/lib/format';
import {
  formatModifierLines,
  groupByCategory,
  sanitize,
} from '@shared/lib/groupOrderItemsForReceipt';
import i18n from '@shared/lib/i18n';

const LINE = 32;

// WR-02: `printer.rs` sends `line.as_bytes()` — raw UTF-8 bytes — with no
// codepage transcoding, so column math here must be measured in UTF-8 bytes,
// not UTF-16 code units (`.length`), or accented/multi-byte characters (e.g.
// `★`, `á/é/í/ó/ú/ñ`) silently misalign the physical receipt.
function byteWidth(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Truncates by whole characters until `s` fits within `width` UTF-8 bytes — never splits a multi-byte character. */
function truncateToByteWidth(s: string, width: number): string {
  if (byteWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = byteWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** Same as {@link truncateToByteWidth} but keeps the trailing bytes (mirrors the old `.slice(-width)`). */
function truncateFromEndToByteWidth(s: string, width: number): string {
  if (byteWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of Array.from(s).reverse()) {
    const cw = byteWidth(ch);
    if (w + cw > width) break;
    out = ch + out;
    w += cw;
  }
  return out;
}

function padRight(s: string, width: number): string {
  const t = truncateToByteWidth(s, width);
  return t + ' '.repeat(Math.max(0, width - byteWidth(t)));
}

/** Splits `s` into consecutive chunks of at most `width` UTF-8 bytes each, advancing by characters actually consumed — never drops or re-slices multi-byte characters (WR-01). */
function chunkByByteWidth(s: string, width: number): string[] {
  const chunks: string[] = [];
  let rest = s;
  while (rest.length > 0) {
    const chunk = truncateToByteWidth(rest, width);
    chunks.push(chunk);
    rest = rest.slice(chunk.length);
  }
  return chunks;
}

function lineLeftRight(left: string, right: string, width: number = LINE): string {
  const r = byteWidth(right) >= width ? truncateFromEndToByteWidth(right, width) : right;
  const maxLeft = width - byteWidth(r);
  const l =
    byteWidth(left) > maxLeft ? `${truncateToByteWidth(left, Math.max(0, maxLeft - 1))}~` : left;
  return padRight(l, width - byteWidth(r)) + r;
}

function centerLine(text: string, width: number = LINE): string {
  const tw = byteWidth(text);
  if (tw >= width) return truncateToByteWidth(text, width);
  const pad = Math.floor((width - tw) / 2);
  return ' '.repeat(pad) + text + ' '.repeat(width - pad - tw);
}

function divider(width: number = LINE): string {
  return '-'.repeat(width);
}

/** Resolves a locale-scoped translator for the `receipt` catalog namespace. */
function receiptT(locale: Locale) {
  return i18n.getFixedT(locale, 'receipt');
}

const PAYMENT_METHOD_LABEL_KEY = {
  cash: 'receipt.method.cash',
  card: 'receipt.method.card',
  bank_transfer: 'receipt.method.bankTransfer',
  rappi: 'receipt.method.rappi',
  uber_eats: 'receipt.method.uberEats',
} as const;

function paymentMethodLabel(method: ReceiptData['paymentMethod'], locale: Locale): string {
  const tr = receiptT(locale);
  return tr(PAYMENT_METHOD_LABEL_KEY[method]);
}

// ============================================================================
// PRE-CHEQUE
// ============================================================================

export type PreChequeData = {
  storeName: string;
  tableLabel: string;
  customerName: string;
  cashierName: string;
  happyHourActive: boolean;
  items: Array<{
    name: string;
    quantity: number;
    lineTotal: number;
    orderedAt: Date;
    modifierNames: string[];
    notes: string | null;
    categoryId: string | null;
    categoryName: string | null;
  }>;
  poolCharge: {
    tableLabel: string;
    billedMinutes: number;
    ratePerHour: number;
    amount: number;
  } | null;
  subtotal: number;
  generatedAt: Date;
};

/** Pre-cheque for 58mm thermal printer (32 columns). Shows balance due before final payment. */
export function buildPreChequeText(data: PreChequeData, locale: Locale): string {
  const tr = receiptT(locale);
  const lines: string[] = [];

  lines.push(centerLine(sanitize(data.storeName) || 'Bar'));
  lines.push(centerLine(tr('precheque.title')));
  lines.push(centerLine(tr('precheque.subtitle')));
  lines.push(divider());
  lines.push(lineLeftRight(tr('precheque.date'), data.generatedAt.toLocaleString(locale)));
  lines.push(lineLeftRight(tr('precheque.cashier'), sanitize(data.cashierName)));
  lines.push(lineLeftRight(tr('precheque.customer'), sanitize(data.customerName)));
  lines.push(lineLeftRight(tr('precheque.table'), sanitize(data.tableLabel)));
  if (data.happyHourActive) {
    lines.push(centerLine(tr('precheque.happyHour')));
  }
  lines.push(divider());

  const preChequeGroups = groupByCategory(data.items, locale);
  for (const group of preChequeGroups) {
    if (preChequeGroups.length > 1) {
      lines.push(centerLine(group.categoryName ?? tr('receipt.category.other')));
    }
    for (const item of group.items) {
      const left = `${String(item.quantity)}x ${sanitize(item.name)}`;
      lines.push(lineLeftRight(left, formatMoneyIn(locale, item.lineTotal)));
      lines.push(...formatModifierLines(item.modifierNames));
      if (item.notes) {
        lines.push(`  ${tr('precheque.note')}: ${sanitize(item.notes)}`);
      }
    }
  }

  if (data.poolCharge !== null) {
    lines.push(divider());
    const label = `${tr('precheque.pool')} ${String(data.poolCharge.billedMinutes)}m @ ${formatMoneyIn(locale, data.poolCharge.ratePerHour)}/h`;
    lines.push(lineLeftRight(label, formatMoneyIn(locale, data.poolCharge.amount)));
  }

  lines.push(divider());
  lines.push(lineLeftRight(tr('precheque.subtotal'), formatMoneyIn(locale, data.subtotal)));
  lines.push('');
  lines.push(centerLine(tr('precheque.pending')));
  lines.push('');

  return lines.join('\n');
}

/** Plain text for 58mm thermal printer (settings.paperWidthChars columns). Keep aligned with Rust `commands/printer.rs` ESC/POS encoder. */
export function buildThermalReceiptText(
  receipt: ReceiptData,
  locale: Locale,
  settings: ReceiptSettings
): string {
  const tr = receiptT(locale);
  const lines: string[] = [];
  const width = settings.paperWidthChars;
  const dt =
    receipt.processedAt instanceof Date
      ? receipt.processedAt
      : new Date(receipt.processedAt as unknown as string);

  lines.push(centerLine(sanitize(receipt.storeName) || 'Bar', width));
  if (settings.headerLine2) lines.push(centerLine(sanitize(settings.headerLine2), width));
  if (receipt.barAddress) {
    const addr = sanitize(receipt.barAddress);
    for (const chunk of chunkByByteWidth(addr, width)) {
      lines.push(padRight(chunk, width));
    }
  }
  lines.push(divider(width));
  lines.push(lineLeftRight(tr('receipt.date'), dt.toLocaleString(locale), width));
  if (settings.showCashierName) {
    lines.push(lineLeftRight(tr('receipt.cashier'), sanitize(receipt.cashierName), width));
  }
  if (settings.showCustomerName) {
    lines.push(lineLeftRight(tr('receipt.customer'), sanitize(receipt.customerName), width));
  }
  lines.push(divider(width));

  const groups = groupByCategory(receipt.items, locale);
  for (const group of groups) {
    if (groups.length > 1) {
      lines.push(centerLine(group.categoryName ?? tr('receipt.category.other'), width));
    }
    for (const item of group.items) {
      const left =
        item.weightGrams != null
          ? `${(item.weightGrams / 1000).toFixed(3)}kg x ${sanitize(item.name)}`
          : `${String(item.quantity)}x ${sanitize(item.name)}`;
      const price = formatMoneyIn(locale, item.lineTotal);
      lines.push(lineLeftRight(left, price, width));
      if ((item.discountAmount ?? 0) > 0) {
        const rate = item.discountRate == null ? '' : ` ${String(item.discountRate)}%`;
        lines.push(
          lineLeftRight(
            `${tr('receipt.promotion')}${rate}`,
            `-${formatMoneyIn(locale, item.discountAmount ?? 0)}`,
            width
          )
        );
      }
      lines.push(...formatModifierLines(item.modifierNames ?? []));
    }
  }

  lines.push(divider(width));
  lines.push(lineLeftRight(tr('receipt.subtotal'), formatMoneyIn(locale, receipt.subtotal), width));
  if ((receipt.discountAmount ?? 0) > 0) {
    lines.push(
      lineLeftRight(
        tr('receipt.discount'),
        `-${formatMoneyIn(locale, receipt.discountAmount ?? 0)}`,
        width
      )
    );
  }
  if (receipt.taxAmount != null) {
    lines.push(lineLeftRight(tr('receipt.tax'), formatMoneyIn(locale, receipt.taxAmount), width));
  }
  lines.push(lineLeftRight(tr('receipt.total'), formatMoneyIn(locale, receipt.total), width));

  // A split sale (more than one tender leg) prints one concise line per
  // leg instead of the single payment/tendered/change lines below — the
  // basket/subtotal/total above are never repeated per leg (CHK-04, CR-03).
  if (receipt.tenders && receipt.tenders.length > 1) {
    for (const tenderLeg of receipt.tenders) {
      lines.push(
        lineLeftRight(
          paymentMethodLabel(tenderLeg.method, locale),
          formatMoneyIn(locale, tenderLeg.amount),
          width
        )
      );
      if (tenderLeg.method === 'cash' && tenderLeg.tenderedAmount != null) {
        lines.push(
          lineLeftRight(
            tr('receipt.tendered'),
            formatMoneyIn(locale, tenderLeg.tenderedAmount),
            width
          )
        );
        lines.push(
          lineLeftRight(
            tr('receipt.change'),
            formatMoneyIn(locale, tenderLeg.changeAmount ?? 0),
            width
          )
        );
      }
      if (tenderLeg.terminalReference) {
        lines.push(lineLeftRight(tr('receipt.ref'), tenderLeg.terminalReference, width));
      }
    }
  } else {
    lines.push(
      lineLeftRight(tr('receipt.payment'), paymentMethodLabel(receipt.paymentMethod, locale), width)
    );

    if (receipt.paymentMethod === 'cash' && receipt.tenderedAmount != null) {
      lines.push(
        lineLeftRight(tr('receipt.tendered'), formatMoneyIn(locale, receipt.tenderedAmount), width)
      );
      lines.push(
        lineLeftRight(tr('receipt.change'), formatMoneyIn(locale, receipt.changeAmount ?? 0), width)
      );
    }

    if (receipt.terminalReference) {
      lines.push(lineLeftRight(tr('receipt.ref'), receipt.terminalReference, width));
    }
  }

  lines.push(divider(width));
  if (settings.showReceiptNumber) {
    lines.push(centerLine(`#${receipt.receiptNumber}`, width));
  }
  if (settings.footerText) {
    lines.push(divider(width));
    // WR-02: split on the Textarea's literal line breaks BEFORE sanitize() strips
    // them as control bytes, so a store owner's typed paragraphs stay separate
    // lines instead of silently merging into one run-together string.
    const paragraphs = settings.footerText.split(/\r\n|\r|\n/).map(p => sanitize(p));
    for (const paragraph of paragraphs) {
      if (paragraph.length === 0) {
        lines.push(padRight('', width));
        continue;
      }
      for (const chunk of chunkByByteWidth(paragraph, width)) {
        lines.push(padRight(chunk, width));
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}
