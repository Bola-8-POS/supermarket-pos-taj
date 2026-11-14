/**
 * One chat turn: screen -> model -> strict parse -> decide -> authorized read, or a staged write -> typed reply.
 * The model only proposes; nothing here trusts its text, and every failure is a typed refusal (no repair retry).
 * A write is never executed here: it is staged and previewed by the server, then approved with a manager PIN.
 */
import type {
  ApproveInput,
  ExpiryListResult,
  LowStockResult,
  LowStockTarget,
  PriceStageItem,
  ProductLookupResult,
  StageInput,
  StageItem,
} from '@entities/assistant';
import type {
  AssistantApproveResult,
  AssistantFinishResult,
  AssistantGate,
  AssistantPreviewItem,
  AssistantRecentSale,
  AssistantSalesSummary,
  AssistantStageResult,
} from '@shared/lib/domain';
import type { LocalModel } from '@shared/lib/local-assistant/model';
import type {
  AssistantReply,
  BatchItem,
  PendingBatch,
  PreviewReply,
  RefusalReply,
} from '@shared/lib/local-assistant/presenter';
import { priceAfterPercentOff } from '@shared/lib/local-assistant/price-math';
import { POLICY_VERSION, PROMPT_VERSION, buildMessages, screenInput } from '@shared/lib/local-assistant/prompt';
import { parseProposal, type AssistantCode, type AssistantError, type Proposal } from '@shared/lib/local-assistant/proposal';
import { route } from '@shared/lib/local-assistant/router';
import type { StaffAction } from '@shared/lib/rbac';
import type { Result } from '@shared/lib/result';
import { decide, type Decision } from './tool-registry';

export const MAX_TURNS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

type ProductListArgs = Extract<Decision, { kind: 'product.list' }>['args'];

export type TurnResult = AssistantReply | { type: 'cancelled' };

/** What the write branch needs from the server contract; absent in read-only callers (a write then fails closed). */
export type WriteDeps = {
  gate: () => Promise<Result<AssistantGate, AssistantError>>;
  stage: (input: StageInput) => Promise<Result<AssistantStageResult, AssistantError>>;
  approve: (input: ApproveInput) => Promise<Result<AssistantApproveResult, AssistantError>>;
  cancel: (proposalId: string, reason: 'user' | 'expired') => Promise<Result<unknown, AssistantError>>;
  /** Price batches only: applies the approved prices one by one, then asks the server to verify them (Plan 29-05). */
  applyPrices: (
    proposalId: string,
    items: AssistantPreviewItem[]
  ) => Promise<Result<AssistantFinishResult, AssistantError>>;
  /** Resolves to the server's answer (`locked` when this was the refusal that tripped the cool-down); never rejects. */
  recordRejection: (
    code: AssistantCode,
    kind: string | null
  ) => Promise<Result<{ locked?: boolean | undefined; until?: string | null | undefined }, AssistantError> | undefined>;
  terminalId: string;
  /** `modelId@runtimeTag` of the loaded model. */
  modelTag: string;
};

export type GatewayDeps = {
  model: Pick<LocalModel, 'propose'>;
  reads: {
    'product.lookup': (query: string) => Promise<Result<ProductLookupResult, AssistantError>>;
    'expiry.list': (withinDays: number | null) => Promise<Result<ExpiryListResult, AssistantError>>;
    'stock.low': (target: LowStockTarget) => Promise<Result<LowStockResult, AssistantError>>;
    'sales.summary': () => Promise<Result<AssistantSalesSummary, AssistantError>>;
    'product.list': (args: ProductListArgs) => Promise<Result<ProductLookupResult, AssistantError>>;
    /** `limit` null = the default; the scope is decided by the gateway from RBAC, never by the model. */
    'sales.recent': (limit: number | null, scope: 'all' | 'own') => Promise<Result<AssistantRecentSale[], AssistantError>>;
  };
  can: (action: StaffAction) => boolean;
  writes?: WriteDeps;
  /** The refusal this turn recorded was the one that locked the assistant (D-15): the panel flips to lockout at once. */
  onLocked?: (until: string | null) => void;
  signal?: AbortSignal;
  now?: () => number;
};

// ponytail: module-level limiter (one signed-in staff per terminal); a per-staff map only if terminals ever share a renderer.
let turnTimes: number[] = [];
let inFlight = false;

/** Test hook. */
export function resetGatewayState(): void {
  turnTimes = [];
  inFlight = false;
}

const SCOPE_ALL = 'all';
const SCOPE_OWN = 'own';

const refusal = (code: AssistantCode): RefusalReply => ({ type: 'refusal', code });

/** The reason the server records for every price batch (it accepts any lowercase word with underscores). */
const PRICE_REASON = 'price_change';

/**
 * Refusals the client decides itself count toward the server cool-down (D-15). NOT_FOUND, a pending typed choice,
 * rate limits and model/data outages are not refusals of the request. Codes returned by the stage and approve
 * RPCs are recorded server-side and never come through here (no double count).
 */
const COUNTED: ReadonlySet<AssistantCode> = new Set<AssistantCode>([
  'INPUT_TOO_LONG',
  'PAYMENT_DATA',
  'MODEL_REFUSED_UNSAFE',
  'MODEL_REFUSED_UNSUPPORTED',
  'MODEL_REFUSED_AMBIGUOUS',
  'INVALID_PROPOSAL',
  'AUTH_FORBIDDEN',
]);

function counted(deps: Pick<GatewayDeps, 'writes' | 'onLocked'>, code: AssistantCode, kind: string | null): RefusalReply {
  // Fire and forget: the wrapper never rejects, and a failed report must not change what the staff member sees.
  if (COUNTED.has(code)) {
    void deps.writes?.recordRejection(code, kind).then(ack => {
      if (ack?.ok && ack.data.locked === true) deps.onLocked?.(ack.data.until ?? null);
    });
  }
  return refusal(code);
}

/** The server cool-down is on: nothing reaches the model or any read. `until` is when it ends (server clock). */
const lockedRefusal = (until: string | null): RefusalReply =>
  until === null ? refusal('ASSISTANT_LOCKED') : { type: 'refusal', code: 'ASSISTANT_LOCKED', until };

/** Runs the one authorized read the decision names and shapes its typed reply; a read failure is a typed refusal. */
async function executeRead(
  decision: Extract<Decision, { type: 'read' }>,
  deps: GatewayDeps
): Promise<AssistantReply> {
  const reply = await readReply(decision, deps);
  return reply.type === 'refusal' ? counted(deps, reply.code, decision.kind) : reply;
}

async function readReply(
  decision: Extract<Decision, { type: 'read' }>,
  deps: GatewayDeps
): Promise<AssistantReply> {
  switch (decision.kind) {
    case 'product.lookup': {
      const read = await deps.reads['product.lookup'](decision.args.query);
      return read.ok ? { type: 'result', kind: 'product.lookup', ...read.data } : refusal(read.error.code);
    }
    case 'expiry.list': {
      const read = await deps.reads['expiry.list'](decision.args.withinDays);
      return read.ok ? { type: 'result', kind: 'expiry.list', ...read.data } : refusal(read.error.code);
    }
    case 'stock.low':
      return lowStockReply(await deps.reads['stock.low']({ query: decision.args.supplierQuery }));
    case 'product.list': {
      const read = await deps.reads['product.list'](decision.args);
      return read.ok
        ? { type: 'result', kind: 'product.list', ...read.data, sort: decision.args.sort }
        : refusal(read.error.code);
    }
    case 'sales.recent': {
      // manager/admin (view_reports) see every sale; anyone else only their own, today (the read enforces it).
      const scope = deps.can('view_reports') ? SCOPE_ALL : SCOPE_OWN;
      const read = await deps.reads['sales.recent'](decision.args.limit, scope);
      return read.ok ? { type: 'result', kind: 'sales.recent', sales: read.data, scope } : refusal(read.error.code);
    }
    case 'sales.summary': {
      const read = await deps.reads['sales.summary']();
      return read.ok ? { type: 'result', kind: 'sales.summary', summary: read.data } : refusal(read.error.code);
    }
  }
}

function lowStockReply(read: Result<LowStockResult, AssistantError>): AssistantReply {
  if (!read.ok) return refusal(read.error.code);
  const { data } = read;
  return data.type === 'choose'
    ? { type: 'choose', kind: 'stock.low', options: data.options }
    : { type: 'result', kind: 'stock.low', rows: data.rows, more: data.more, supplierName: data.supplierName };
}

/**
 * The staff tapped one supplier of a typed choice: re-run only the low-stock read for that supplier id.
 * No model turn, so no screening, rate limit or in-flight slot is used.
 */
export async function runChoice(supplierId: string, deps: GatewayDeps): Promise<TurnResult> {
  const reply = lowStockReply(await deps.reads['stock.low']({ supplierId }));
  return deps.signal?.aborted ? { type: 'cancelled' } : reply;
}

export async function runTurn(text: string, deps: GatewayDeps): Promise<TurnResult> {
  // D-15: the cool-down gate runs before every turn, reads included, and fails closed when it cannot be read.
  if (deps.writes) {
    const gate = await deps.writes.gate();
    if (!gate.ok) return refusal(gate.error.code);
    if (gate.data.locked) return lockedRefusal(gate.data.until);
    if (deps.signal?.aborted) return { type: 'cancelled' };
  }

  const screened = screenInput(text);
  if (!screened.ok) return counted(deps, screened.code, null);

  const now = (deps.now ?? Date.now)();
  turnTimes = turnTimes.filter(t => now - t < WINDOW_MS);
  if (inFlight || turnTimes.length >= MAX_TURNS_PER_MINUTE) return refusal('RATE_LIMITED');
  turnTimes.push(now);

  inFlight = true;
  try {
    // A confident keyword match skips the model; its proposal takes the same decide/grounding/RBAC/approval path.
    let proposal: Proposal | null = route(screened.text);
    const routed = proposal !== null;
    if (proposal === null) {
      const proposed = await deps.model.propose(buildMessages(screened.text), deps.signal);
      if (deps.signal?.aborted) return { type: 'cancelled' };
      if (!proposed.ok) return refusal(proposed.error.code);
      proposal = parseProposal(proposed.data);
      if (proposal === null) return counted(deps, 'INVALID_PROPOSAL', null);
    }

    const decision = decide(proposal, deps.can, screened.text);
    if (decision.type === 'refuse') {
      // The grounding guard asking for a clearer request is not a rejected request: it never feeds the cool-down.
      // Nor does a refusal the deterministic router gave (an unsupported ranking, a stock word, a percent out of range).
      if (proposal.kind === 'refuse' ? routed : decision.code === 'MODEL_REFUSED_AMBIGUOUS') return refusal(decision.code);
      return counted(deps, decision.code, proposal.kind);
    }

    const reply =
      decision.type === 'write'
        ? await stageWrite(decision, screened.text, deps)
        : await executeRead(decision, deps);
    if (deps.signal?.aborted) return { type: 'cancelled' };
    return reply;
  } finally {
    inFlight = false;
  }
}

/** The staff member's own words only: a model-extracted query is echoed back solely when the staff typed it. */
const typedBy = (userText: string, query: string): string | undefined =>
  userText.toLowerCase().includes(query.toLowerCase()) ? query : undefined;

/**
 * Write branch: look every item up on the caller's session (in parallel, at most 25), then settle the batch.
 * The cool-down gate already ran at the start of the turn. Nothing is executed here.
 */
async function stageWrite(
  decision: Extract<Decision, { type: 'write' }>,
  userText: string,
  deps: GatewayDeps
): Promise<AssistantReply> {
  const writes = deps.writes;
  if (!writes) return refusal('DATA_UNAVAILABLE');

  const requested: { query: string; change: { delta: number } | { priceCents: number } | { percentOff: number } }[] = [];
  if (decision.kind === 'inventory.adjust') {
    for (const i of decision.args.items) requested.push({ query: i.query, change: { delta: i.delta } });
  } else {
    for (const i of decision.args.items) {
      // A percent is applied to the price read below; an absolute price is only used when no percent was asked.
      if (i.percentOff !== null) requested.push({ query: i.query, change: { percentOff: i.percentOff } });
      else if (i.priceCents !== null) requested.push({ query: i.query, change: { priceCents: i.priceCents } });
      else return counted(deps, 'INVALID_PROPOSAL', decision.kind);
    }
  }
  const reason = decision.kind === 'inventory.adjust' ? decision.args.reason : PRICE_REASON;
  const lookups = await Promise.all(requested.map(item => deps.reads['product.lookup'](item.query)));

  const batch: BatchItem[] = [];
  for (const [i, item] of requested.entries()) {
    const lookup = lookups[i];
    if (!lookup) return refusal('DATA_UNAVAILABLE');
    if (!lookup.ok) return counted(deps, lookup.error.code, decision.kind);
    // More matches than the lookup cap: the right product may not be among them, so ask for a clearer name.
    if (lookup.data.more) return refusal('MODEL_REFUSED_AMBIGUOUS');
    // A stock change needs a stock record; a price change does not.
    const candidates =
      decision.kind === 'inventory.adjust'
        ? lookup.data.rows.filter(row => row.quantityOnHand !== null)
        : lookup.data.rows;
    batch.push({
      ...item.change,
      label: typedBy(userText, item.query) ?? null,
      candidates,
      chosenId: candidates.length === 1 ? (candidates[0]?.productId ?? null) : null,
    });
  }
  return settleBatch({ kind: decision.kind, reason, userText, items: batch }, deps);
}

/**
 * Every item resolved to one product -> stage on the server (it builds and hashes the preview). Any item with
 * several candidates -> a typed choice first. Any item with none -> NOT_FOUND, naming it only when the staff typed it.
 */
async function settleBatch(batch: PendingBatch, deps: Pick<GatewayDeps, 'writes'>): Promise<AssistantReply> {
  const writes = deps.writes;
  if (!writes) return refusal('DATA_UNAVAILABLE');

  for (const item of batch.items) {
    if (item.candidates.length === 0) {
      return item.label === null ? refusal('NOT_FOUND') : { type: 'refusal', code: 'NOT_FOUND', query: item.label };
    }
  }
  const chosen = batch.items.map(item => item.chosenId);
  const seen = new Set<string>();
  for (const id of chosen) {
    if (id === null) continue;
    if (seen.has(id)) return counted(deps, 'INVALID_PROPOSAL', batch.kind);
    seen.add(id);
  }
  if (chosen.includes(null)) return { type: 'choose-products', kind: batch.kind, pending: batch };

  if (priceTooLow(batch)) return refusal('PRICE_TOO_LOW');
  const input = buildStageInput(batch, {
    reason: batch.reason,
    terminalId: writes.terminalId,
    model: writes.modelTag,
    policyVersion: POLICY_VERSION,
    promptVersion: PROMPT_VERSION,
    rawText: batch.userText,
  });
  if (input === null) return refusal('DATA_UNAVAILABLE');
  const result = await writes.stage(input);
  if (!result.ok) return refusal(result.error.code);
  const percents = Object.fromEntries(
    batch.items.flatMap(item => ('percentOff' in item && item.chosenId !== null ? [[item.chosenId, item.percentOff] as const] : []))
  );
  return {
    type: 'preview',
    kind: batch.kind,
    ...(Object.keys(percents).length > 0 ? { percents } : {}),
    proposalId: result.data.proposal_id,
    payloadHash: result.data.payload_hash,
    expiresInSeconds: result.data.expires_in_seconds,
    items: result.data.items,
  };
}

/** A percent discount whose new price is under one cent or no different from the current one: nothing to stage. */
function priceTooLow(batch: PendingBatch): boolean {
  return batch.items.some(item => {
    if (!('percentOff' in item)) return false;
    const row = item.candidates.find(c => c.productId === item.chosenId);
    if (!row) return false;
    const after = priceAfterPercentOff(row.price, item.percentOff);
    return after === null || after === Math.round(row.price * 100);
  });
}

type StageCommon = Omit<StageInput, 'kind' | 'items'>;

/**
 * The resolved batch as the server's stage input. The expected values are the ones the staff member's own session
 * just read (stock on hand; price and row version); the server compares them again and refuses STALE_TARGET.
 * Null when a value that must exist is missing (fail closed).
 */
function buildStageInput(batch: PendingBatch, common: StageCommon): StageInput | null {
  if (batch.kind === 'inventory.adjust') {
    const items: StageItem[] = [];
    for (const item of batch.items) {
      const row = item.candidates.find(c => c.productId === item.chosenId);
      if (!row || row.quantityOnHand === null || !('delta' in item)) return null;
      items.push({ product_id: row.productId, delta: item.delta, expected_quantity: row.quantityOnHand });
    }
    return { ...common, kind: 'inventory.adjust', items };
  }
  const items: PriceStageItem[] = [];
  for (const item of batch.items) {
    const row = item.candidates.find(c => c.productId === item.chosenId);
    if (!row || row.updatedAt === undefined) return null;
    // A percent change is computed here from the price just read; the server still compares expected_price.
    const cents = 'percentOff' in item ? priceAfterPercentOff(row.price, item.percentOff) : 'priceCents' in item ? item.priceCents : null;
    if (cents === null) return null;
    items.push({
      product_id: row.productId,
      price: cents / 100,
      expected_price: row.price,
      expected_updated_at: row.updatedAt,
    });
  }
  return { ...common, kind: 'product.price', items };
}

/**
 * The staff picked one candidate for one ambiguous item. No model turn (no screening, rate-limit slot or in-flight
 * flag): the pending batch already holds the typed data, and the batch is staged once every item is resolved.
 */
export async function runBatchChoice(
  pending: PendingBatch,
  itemIndex: number,
  productId: string,
  deps: Pick<GatewayDeps, 'writes'>
): Promise<AssistantReply> {
  const item = pending.items[itemIndex];
  if (!item || !item.candidates.some(c => c.productId === productId)) {
    return counted(deps, 'INVALID_PROPOSAL', pending.kind);
  }
  const items = pending.items.map((it, i) => (i === itemIndex ? { ...it, chosenId: productId } : it));
  return settleBatch({ ...pending, items }, deps);
}

/** The manager/admin PIN ticket was issued: ask the server to execute the staged batch, all or nothing. */
export async function runApproval(
  preview: PreviewReply,
  approverId: string,
  approvalId: string,
  deps: Pick<GatewayDeps, 'writes'>
): Promise<AssistantReply> {
  const writes = deps.writes;
  if (!writes) return refusal('DATA_UNAVAILABLE');
  const result = await writes.approve({
    proposalId: preview.proposalId,
    payloadHash: preview.payloadHash,
    approvalId,
    approverId,
    terminalId: writes.terminalId,
  });
  if (!result.ok) return refusal(result.error.code);
  if (preview.kind === 'product.price') {
    // The server only authorized the change: the prices are written with the staff member's own session, one by one,
    // and the server's verdict (assistant_finish re-reads every price), not ours, is what the panel shows.
    if (result.data.status !== 'executing') return refusal('EXECUTION_FAILED');
    const finished = await writes.applyPrices(preview.proposalId, result.data.items);
    // Some prices may already be written: say so (the proposal stays `executing` and is reconciled by the server).
    if (!finished.ok) return refusal('RESULT_UNCONFIRMED');
    return { type: 'outcome', kind: preview.kind, status: finished.data.status, items: finished.data.items };
  }
  return { type: 'outcome', kind: preview.kind, status: 'executed', items: result.data.items };
}

/**
 * Cancel (staff) or expiry (the 2-minute window ran out). A failed cancel still ends the preview on screen (a staged
 * proposal times out on the server). ALREADY_USED means an approval got there first: null, the approve path owns
 * what the card shows, so a late expiry never overwrites a committed write (WR-01).
 */
export async function runCancel(
  preview: PreviewReply,
  reason: 'user' | 'expired',
  deps: Pick<GatewayDeps, 'writes'>
): Promise<AssistantReply | null> {
  const res = await deps.writes?.cancel(preview.proposalId, reason);
  if (res && !res.ok && res.error.code === 'ALREADY_USED') return null;
  return {
    type: 'outcome',
    kind: preview.kind,
    status: reason === 'expired' ? 'expired' : 'cancelled',
    items: preview.items,
  };
}
