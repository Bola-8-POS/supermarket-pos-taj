/**
 * Allow-list of what the model may ask for. An unregistered kind never reaches a read (T-29-01).
 * Pure: no supabase imports, so the Plan 29-07 harness can load it.
 */
import { ground } from '@shared/lib/local-assistant/grounding';
import { MAX_BATCH_ITEMS, type Proposal, type ProposalKind, type AssistantCode } from '@shared/lib/local-assistant/proposal';
import type { StaffAction } from '@shared/lib/rbac';

export type ToolKind = Exclude<ProposalKind, 'refuse'>;
export type WriteKind = Extract<ToolKind, 'inventory.adjust' | 'product.price'>;
export type ReadKind = Exclude<ToolKind, WriteKind>;

export type ToolEntry =
  | {
      kind: ReadKind;
      access: 'read';
      /** RBAC action the caller must hold, or null when existing RLS alone gates the read. */
      action: StaffAction | null;
      auditAction: null;
      maxRows: number;
    }
  | {
      kind: WriteKind;
      access: 'write';
      /** The requester must hold it (D-11); the approver's PIN is checked for the same action on the server. */
      action: StaffAction;
      requiresPin: true;
      /** Written server-side by assistant_approve; the client cannot write assistant.* audit rows. */
      auditAction: 'assistant.executed';
      maxItems: number;
    };

export const TOOL_REGISTRY = {
  // Catalog reads carry no role action: products_select_authenticated already lets every signed-in role read them.
  'product.lookup': { kind: 'product.lookup', access: 'read', action: null, auditAction: null, maxRows: 10 },
  // Inventory is readable by every signed-in role (the stock and expiry alerts show it on every till).
  'expiry.list': { kind: 'expiry.list', access: 'read', action: null, auditAction: null, maxRows: 25 },
  'stock.low': { kind: 'stock.low', access: 'read', action: null, auditAction: null, maxRows: 25 },
  // Same catalog read, any filter (the panel caps and sorts it). Open to every signed-in role like product.lookup.
  'product.list': { kind: 'product.list', access: 'read', action: null, auditAction: null, maxRows: 50 },
  // Recent sales are payments rows. payments_select_bartender (RLS) lets any role holding close_tab read them
  // all, so that is the gate here; WHICH rows is decided in the gateway: view_reports -> all, otherwise the
  // caller's own sales from today (the query filter enforces it, RLS is not widened).
  'sales.recent': { kind: 'sales.recent', access: 'read', action: 'close_tab', auditAction: null, maxRows: 20 },
  // The caja report is money data: the role matrix decides (D-06 item 4, D-11). The server wrapper
  // assistant_sales_summary (migration 20261108000001) enforces the same action, so this is not the only gate.
  'sales.summary': { kind: 'sales.summary', access: 'read', action: 'view_reports', auditAction: null, maxRows: 1 },
  // D-07: the first write. Staged and previewed server-side, approved with a manager/admin PIN, executed in one RPC.
  'inventory.adjust': {
    kind: 'inventory.adjust',
    access: 'write',
    action: 'adjust_inventory',
    requiresPin: true,
    auditAction: 'assistant.executed',
    maxItems: MAX_BATCH_ITEMS,
  },
  // D-07: the second write. Same stage -> PIN -> approve contract; the client then applies the prices through the
  // product update path (RLS products_update_manager_admin is the authority) and assistant_finish verifies them.
  'product.price': {
    kind: 'product.price',
    access: 'write',
    action: 'manage_products',
    requiresPin: true,
    auditAction: 'assistant.executed',
    maxItems: MAX_BATCH_ITEMS,
  },
} satisfies Record<ToolKind, ToolEntry>;

export type WriteProposal = Extract<Proposal, { kind: WriteKind }>;
type ReadProposal = Exclude<Proposal, { kind: 'refuse' | WriteKind }>;

/** A registered read or write: the proposal minus the refuse variant, tagged with its access type. */
export type Decision =
  | { type: 'refuse'; code: AssistantCode }
  | ({ type: 'read' } & ReadProposal)
  | ({ type: 'write' } & WriteProposal);

const REFUSAL_CODE = {
  unsupported: 'MODEL_REFUSED_UNSUPPORTED',
  unsafe: 'MODEL_REFUSED_UNSAFE',
  ambiguous: 'MODEL_REFUSED_AMBIGUOUS',
} as const satisfies Record<Extract<Proposal, { kind: 'refuse' }>['reason'], AssistantCode>;

/**
 * `userText` is what the staff typed: every free-text and numeric arg the model filled must come from it
 * (grounding guard). Optional ones that did not are dropped; a required one that did not asks for clarification.
 */
export function decide(raw: Proposal, can: (action: StaffAction) => boolean, userText: string): Decision {
  if (raw.kind === 'refuse') return { type: 'refuse', code: REFUSAL_CODE[raw.reason] };
  const entry = (TOOL_REGISTRY as Partial<Record<string, ToolEntry>>)[raw.kind];
  if (!entry) return { type: 'refuse', code: 'MODEL_REFUSED_UNSUPPORTED' };
  if (entry.action !== null && !can(entry.action)) return { type: 'refuse', code: 'AUTH_FORBIDDEN' };
  // Role first, then grounding: a forbidden request never reveals whether its arguments were grounded.
  const proposal = ground(raw, userText);
  if (proposal === null || proposal.kind === 'refuse') return { type: 'refuse', code: 'MODEL_REFUSED_AMBIGUOUS' };
  return proposal.kind === 'inventory.adjust' || proposal.kind === 'product.price'
    ? { type: 'write', ...proposal }
    : { type: 'read', ...proposal };
}
