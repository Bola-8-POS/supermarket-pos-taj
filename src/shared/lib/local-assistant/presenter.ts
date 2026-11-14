/**
 * Turns a typed gateway reply into i18next keys + typed params (`featMgmt:assistant.*`). Model text is never
 * a param: the only free text that reaches the UI is data read from the database through the caller's session.
 */
import type {
  AssistantExpiryRow,
  AssistantFinishItem,
  AssistantPreviewItem,
  AssistantLowStockRow,
  AssistantProductRow,
  AssistantSalesSummary,
  AssistantSupplierOption,
} from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import type { AssistantCode } from './proposal';

export type LookupReply = {
  type: 'result';
  kind: 'product.lookup';
  rows: AssistantProductRow[];
  /** True when more than the row cap matched. */
  more: boolean;
};
export type ExpiryReply = {
  type: 'result';
  kind: 'expiry.list';
  rows: AssistantExpiryRow[];
  more: boolean;
};
export type LowStockReply = {
  type: 'result';
  kind: 'stock.low';
  rows: AssistantLowStockRow[];
  more: boolean;
  /** Name of the one supplier the list was limited to, or null for the whole store. */
  supplierName: string | null;
};
/** Several suppliers matched: the panel shows one button each; tapping one re-runs only the read. */
export type ChoiceReply = { type: 'choose'; kind: 'stock.low'; options: AssistantSupplierOption[] };
export type SalesReply = { type: 'result'; kind: 'sales.summary'; summary: AssistantSalesSummary };
/**
 * `query` names the product the staff typed when NOT_FOUND is about one item; the gateway sets it only when it is
 * a substring of the staff member's own text, so no model-invented words reach the DOM.
 */
export type RefusalReply = {
  type: 'refusal';
  code: AssistantCode;
  query?: string;
  /** ASSISTANT_LOCKED only: when the cool-down ends (server clock, ISO). */
  until?: string;
};
export type WriteReplyKind = 'inventory.adjust' | 'product.price';
/** One line of a batch while its products are being resolved: a stock change (`delta`) or a price change (`priceCents`). */
export type BatchItem = {
  /** What the staff typed for this item, or null when the model's wording is not in the staff text (never shown then). */
  label: string | null;
  /** Matching products; one means resolved, several mean the staff must pick (D-09). Stock batches only keep products with a stock record. */
  candidates: AssistantProductRow[];
  chosenId: string | null;
} & ({ delta: number } | { priceCents: number });
/** The batch the staff is still resolving; kept in the reply so the choice step needs no model turn. */
export type PendingBatch = {
  kind: WriteReplyKind;
  reason: string;
  /** The screened staff text; stored server-side with the proposal when the batch is staged (D-17). */
  userText: string;
  items: BatchItem[];
};
/** One or more items matched several products: the panel shows every candidate per item (ChoiceCard). */
export type ProductChoiceReply = { type: 'choose-products'; kind: WriteReplyKind; pending: PendingBatch };
/** A staged write, built and hashed by the server: every item with its value before and after (D-09). */
export type PreviewReply = {
  type: 'preview';
  kind: WriteReplyKind;
  proposalId: string;
  payloadHash: string;
  /** Seconds the server gave the preview when it staged it; counted down on the till from the reply's arrival, so the
   * till clock is never compared with a server timestamp. The server re-checks the window on approve. */
  expiresInSeconds: number;
  items: AssistantPreviewItem[];
};
/** The end of a write: executed by the server, or dropped by the staff member / the 2-minute window. */
export type OutcomeReply = {
  type: 'outcome';
  kind: WriteReplyKind;
  /** `partial` and `failed` come from price batches only (assistant_finish). */
  status: 'executed' | 'cancelled' | 'expired' | 'partial' | 'failed';
  /** Price outcomes carry the server's per-item verdict (`result`); stock outcomes do not need one. */
  items: (AssistantPreviewItem | AssistantFinishItem)[];
};
export type AssistantReply =
  | LookupReply
  | ExpiryReply
  | LowStockReply
  | ChoiceReply
  | SalesReply
  | RefusalReply
  | ProductChoiceReply
  | PreviewReply
  | OutcomeReply;

export type PresentedLine = { key: string; params: Record<string, string | number> };
export type Presented = PresentedLine & { lines: PresentedLine[] };

function presentLookup(reply: LookupReply): Presented {
  if (reply.rows.length === 0) {
    return { key: 'assistant.lookup.none', params: {}, lines: [] };
  }
  const lines: PresentedLine[] = reply.rows.map(row => {
    const base = { name: row.name, price: formatMoney(row.price) };
    // Plan 29-11: a recorded shelf gets the *At keys; null or absent keeps the base keys, which say "location not recorded".
    const location = row.shelfLocation?.trim();
    const at = location ? 'At' : '';
    const params = location ? { ...base, location } : base;
    return row.quantityOnHand === null
      ? { key: `assistant.lookup.rowNoStock${at}`, params }
      : { key: `assistant.lookup.row${at}`, params: { ...params, stock: row.quantityOnHand } };
  });
  if (reply.more) lines.push({ key: 'assistant.lookup.more', params: {} });
  return { key: 'assistant.lookup.found', params: { count: reply.rows.length }, lines };
}

function presentExpiry(reply: ExpiryReply): Presented {
  if (reply.rows.length === 0) {
    return { key: 'assistant.expiry.none', params: {}, lines: [] };
  }
  const lines: PresentedLine[] = reply.rows.map(row => {
    const params = { name: row.name, date: row.expiryDate, count: row.daysUntilExpiry };
    if (row.daysUntilExpiry < 0) return { key: 'assistant.expiry.rowExpired', params };
    if (row.daysUntilExpiry === 0) return { key: 'assistant.expiry.rowToday', params };
    return { key: 'assistant.expiry.row', params };
  });
  if (reply.more) lines.push({ key: 'assistant.expiry.more', params: {} });
  return { key: 'assistant.expiry.found', params: { count: reply.rows.length }, lines };
}

function presentLowStock(reply: LowStockReply): Presented {
  if (reply.rows.length === 0) {
    return { key: 'assistant.lowStock.none', params: {}, lines: [] };
  }
  const lines: PresentedLine[] = reply.rows.map(row => ({
    key: 'assistant.lowStock.row',
    params: { name: row.name, stock: row.quantityOnHand, threshold: row.lowStockThreshold },
  }));
  if (reply.more) lines.push({ key: 'assistant.lowStock.more', params: {} });
  return reply.supplierName === null
    ? { key: 'assistant.lowStock.found', params: { count: reply.rows.length }, lines }
    : {
        key: 'assistant.lowStock.foundFor',
        params: { count: reply.rows.length, supplier: reply.supplierName },
        lines,
      };
}

/** Totals by payment method; methods with no sales are left out so the card stays short. */
function presentSales(reply: SalesReply): Presented {
  const s = reply.summary.summary;
  const methods: [string, number][] = [
    ['cash', s.cashSales],
    ['card', s.cardSales],
    ['rappi', s.rappiSales],
    ['uberEats', s.uberEatsSales],
    ['bankTransfer', s.bankTransferSales],
  ];
  const lines: PresentedLine[] = methods
    .filter(([, amount]) => amount > 0)
    .map(([method, amount]) => ({ key: 'assistant.sales.' + method, params: { amount: formatMoney(amount) } }));
  return {
    key: reply.summary.closedAt === null ? 'assistant.sales.open' : 'assistant.sales.closed',
    params: { total: formatMoney(s.totalRevenue), orders: s.orderCount },
    lines,
  };
}

const adjustLines = (items: AssistantPreviewItem[]): PresentedLine[] =>
  items.map(item => ({
    key: 'assistant.adjust.row',
    params: { name: item.name, before: item.before, after: item.after },
  }));

const priceLines = (items: OutcomeReply['items']): PresentedLine[] =>
  items.map(item =>
    'result' in item && item.result !== 'applied'
      ? { key: item.result === 'stale' ? 'assistant.price.rowStale' : 'assistant.price.rowMismatch', params: { name: item.name } }
      : {
          key: 'assistant.price.row',
          params: { name: item.name, before: formatMoney(item.before), after: formatMoney(item.after) },
        }
  );

function presentPriceOutcome(reply: OutcomeReply): Presented {
  const count = reply.items.length;
  if (reply.status === 'partial' || reply.status === 'failed') {
    const open = reply.items.filter(i => 'result' in i && i.result !== 'applied');
    // Product names come from the database through the server's verdict, never from the model.
    const names = open.map(i => i.name).join(', ');
    const applied = count - open.length;
    return reply.status === 'partial'
      ? { key: 'assistant.result.partial', params: { applied, total: count, names }, lines: priceLines(reply.items) }
      : { key: 'assistant.price.failed', params: { count, names }, lines: priceLines(reply.items) };
  }
  return {
    key: `assistant.price.${reply.status}`,
    params: { count },
    lines: reply.status === 'executed' ? priceLines(reply.items) : [],
  };
}

const lockTime = (until: string): string =>
  new Date(until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function present(reply: AssistantReply): Presented {
  if (reply.type === 'refusal') {
    if (reply.code === 'ASSISTANT_LOCKED' && reply.until !== undefined) {
      return { key: 'assistant.lockout', params: { time: lockTime(reply.until) }, lines: [] };
    }
    return reply.code === 'NOT_FOUND' && reply.query !== undefined
      ? { key: 'assistant.errors.NOT_FOUND_QUERY', params: { query: reply.query }, lines: [] }
      : { key: `assistant.errors.${reply.code}`, params: {}, lines: [] };
  }
  if (reply.type === 'choose-products') {
    return { key: 'assistant.adjust.chooseTitle', params: {}, lines: [] };
  }
  if (reply.type === 'preview') {
    return reply.kind === 'product.price'
      ? { key: 'assistant.price.preview', params: { count: reply.items.length }, lines: priceLines(reply.items) }
      : { key: 'assistant.adjust.preview', params: { count: reply.items.length }, lines: adjustLines(reply.items) };
  }
  if (reply.type === 'outcome') {
    if (reply.kind === 'product.price') return presentPriceOutcome(reply);
    return {
      key: `assistant.adjust.${reply.status}`,
      params: { count: reply.items.length },
      lines: reply.status === 'executed' ? adjustLines(reply.items) : [],
    };
  }
  if (reply.type === 'choose') return { key: 'assistant.choose.supplier', params: {}, lines: [] };
  switch (reply.kind) {
    case 'product.lookup':
      return presentLookup(reply);
    case 'expiry.list':
      return presentExpiry(reply);
    case 'stock.low':
      return presentLowStock(reply);
    case 'sales.summary':
      return presentSales(reply);
  }
}
