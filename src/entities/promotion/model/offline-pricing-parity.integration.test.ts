// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

/**
 * Integration test: client total == the total process_direct_sale_atomic derives (two-mode Plan
 * 02b, Task 2b, Ruling 5). An offline sale is priced on the till from cached data and replayed
 * later; the RPC refuses it on any difference above 0.01 (PRICE_MISMATCH per line, AMOUNT_MISMATCH
 * on the total). This file measures that difference against the REAL RPC on the local stack.
 *
 * The client total is built by the same pieces the checkout screen uses, not re-implemented here:
 *   scan   -> resolveProductPromotion -> cartStore.addItem / addWeightedItem
 *   combos -> cartItemsToComboLines -> evaluateCombos -> cartStore.setComboResult
 *   total  -> cartItemsToSyntheticTab -> calculateLineTotal -> formTotal (PaymentForm's arithmetic)
 *   request-> cartItemsToRpcItems (what useCheckoutSale sends)
 *
 * Run: npx vitest run --project integration src/entities/promotion/model/offline-pricing-parity.integration.test.ts
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { calculateLineTotal, formTotal } from '@widgets/PaymentModal/ui/saleTotals';
import {
  cartItemsToRpcItems,
  cartItemsToSyntheticTab,
} from '@features/checkout-sale/model/useCheckoutSale';
import { fetchNearExpiryPricingDates } from '@entities/inventory';
import { mapProductRow } from '@entities/product/model/queries';
import { cartItemsToComboLines, useCartStore } from '@entities/tab/model/cartStore';
import type { NearExpiryPricingDate, Product, Promotion } from '@shared/lib/domain';
import { calculateDiscountAmount } from '@shared/lib/domain-helpers';
import { testDb } from '@shared/lib/supabase-test-client';
import { evaluateCombos, type ComboCategoryLookup } from './combo-pricing';
import { storeLocalDate } from './promotion-pricing';
import { mapPromotionRow } from './queries';
import {
  resolveProductPromotion,
  type PromotionPricingSettings,
} from './resolve-product-promotion';

const hasEnv =
  typeof process.env['VITE_SUPABASE_URL'] === 'string' &&
  process.env['VITE_SUPABASE_URL'] !== '' &&
  typeof process.env['SUPABASE_SERVICE_ROLE_KEY'] === 'string' &&
  process.env['SUPABASE_SERVICE_ROLE_KEY'] !== '';
const itDb = hasEnv ? it : it.skip;
const db = testDb as any;

// The only stack this file may write to. Checked before the first write, not by a test.
const EXPECTED_TARGET = '127.0.0.1:56321';
function targetHost(): string {
  const url =
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
    process.env['VITE_SUPABASE_URL'] ??
    '';
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}
let targetOk = false;

const PARITY_SEED = 20261009;
const PARITY_RUNS = 25;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// The world: one catalog seeded for the whole file, removed in afterAll.
// ---------------------------------------------------------------------------------------------

const startedAt = new Date(Date.now() - 5_000).toISOString();
const tag = `parity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const created = {
  categoryIds: [] as string[],
  productIds: [] as string[],
  promotionIds: [] as string[],
  tabIds: [] as string[],
  shiftId: null as string | null,
  cajaId: null as string | null,
};

/**
 * The store's date, read back from the database itself (the created_at the first seeded row
 * received, taken in the store zone), not from this machine's clock. The near-expiry tier is
 * decided on this date, in the zone of settings.general.timezone (Plan 02c Task 7), not on the
 * database's UTC date.
 */
let serverToday = new Date().toISOString().slice(0, 10);
/** settings.general.timezone as the tests currently see it (a test may flip it and restores it). */
let storeTz = 'America/Mexico_City';

/** The database's date offset by whole days. */
function dbDate(offsetDays: number): string {
  return new Date(Date.parse(serverToday) + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function throwIf(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

async function seedCategory(name: string): Promise<string> {
  const { data, error } = await db
    .from('categories')
    .insert({ name: `${tag} ${name}` })
    .select('id, created_at')
    .single();
  throwIf(error, `category ${name}`);
  created.categoryIds.push(data.id);
  serverToday = storeLocalDate(new Date(String(data.created_at)), storeTz);
  return data.id;
}

async function seedProduct(spec: {
  key: string;
  categoryId: string;
  price: number;
  weighted?: boolean;
  expiryInDays?: number;
}): Promise<string> {
  const { data, error } = await db
    .from('products')
    .insert({
      name: `${tag} ${spec.key}`,
      category_id: spec.categoryId,
      base_price: spec.price,
      is_active: true,
      sold_by_weight: spec.weighted ?? false,
    })
    .select('id')
    .single();
  throwIf(error, `product ${spec.key}`);
  created.productIds.push(data.id);
  // cost 0: the below-cost floor guard (price < cost) must never be what refuses a parity sale
  const inv = await db.from('inventory').insert({
    product_id: data.id,
    quantity_on_hand: 1_000_000,
    cost_price: 0,
    expiry_date: spec.expiryInDays === undefined ? null : dbDate(spec.expiryInDays),
  });
  throwIf(inv.error, `inventory ${spec.key}`);
  return data.id;
}

interface PromoSpec {
  key: string;
  kind?: 'discount' | 'combo';
  type: 'percent' | 'fixed' | 'bundle_price' | 'cheapest_free';
  value: number;
  /** discount kind: product / category targets (none = store-wide, never used here) */
  productIds?: string[];
  categoryIds?: string[];
  /** combo kind: one entry per slot */
  slots?: { quantity: number; productId?: string; categoryId?: string }[];
  startsAt?: Date;
  endsAt?: Date;
  daysOfWeek?: number[] | null;
  startTime?: string | null;
  endTime?: string | null;
}

async function seedPromotion(spec: PromoSpec): Promise<string> {
  const now = Date.now();
  const { data, error } = await db
    .from('promotions')
    .insert({
      name: `${tag} ${spec.key}`,
      kind: spec.kind ?? 'discount',
      discount_type: spec.type,
      discount_value: spec.value,
      starts_at: (spec.startsAt ?? new Date(now - 3_600_000)).toISOString(),
      ends_at: (spec.endsAt ?? new Date(now + 24 * 3_600_000)).toISOString(),
      days_of_week: spec.daysOfWeek ?? null,
      start_time: spec.startTime ?? null,
      end_time: spec.endTime ?? null,
    })
    .select('id')
    .single();
  throwIf(error, `promotion ${spec.key}`);
  const id = data.id as string;
  created.promotionIds.push(id);
  for (const productId of spec.productIds ?? []) {
    throwIf(
      (await db.from('promotion_targets').insert({ promotion_id: id, product_id: productId }))
        .error,
      `target ${spec.key}`
    );
  }
  for (const categoryId of spec.categoryIds ?? []) {
    throwIf(
      (await db.from('promotion_targets').insert({ promotion_id: id, category_id: categoryId }))
        .error,
      `target ${spec.key}`
    );
  }
  for (const [position, slot] of (spec.slots ?? []).entries()) {
    const slotRow = await db
      .from('promotion_combo_slots')
      .insert({ promotion_id: id, position, quantity: slot.quantity })
      .select('id')
      .single();
    throwIf(slotRow.error, `slot ${spec.key}`);
    throwIf(
      (
        await db.from('promotion_targets').insert({
          promotion_id: id,
          product_id: slot.productId ?? null,
          category_id: slot.categoryId ?? null,
          slot_id: slotRow.data.id,
        })
      ).error,
      `slot target ${spec.key}`
    );
  }
  return id;
}

interface World {
  products: Record<string, Product>;
  promotions: Promotion[];
  settings: PromotionPricingSettings;
  tax: { ratePercent: number; inclusive: boolean };
  categories: Map<string, ComboCategoryLookup>;
  nearExpiry: NearExpiryPricingDate[];
  staffId: string;
  shiftId: string;
  cajaId: string;
}

let world: World;
let threshold = 14;

async function loadPromotions(): Promise<Promotion[]> {
  const { data, error } = await db
    .from('promotions')
    .select('*, promotion_targets(*), promotion_combo_slots(*)')
    .eq('active', true);
  throwIf(error, 'load promotions');
  const mapped = (data as any[]).map(row => mapPromotionRow(row));
  return mapped.flatMap(r => (r.ok ? [r.data] : []));
}

async function loadSettings(): Promise<Pick<World, 'settings' | 'tax'>> {
  const { data } = await db
    .from('settings')
    .select('key, value')
    .in('key', ['near_expiry', 'general', 'billing']);
  const byKey = new Map<string, any>((data as any[]).map(r => [r.key, r.value ?? {}]));
  const ne = byKey.get('near_expiry') ?? {};
  const general = byKey.get('general') ?? {};
  const billing = byKey.get('billing') ?? {};
  threshold = Number(ne.thresholdDays ?? 14);
  storeTz = String(general.timezone ?? 'America/Mexico_City');
  return {
    settings: {
      nearExpiry: { discountPercent: Number(ne.discountPercent ?? 15), thresholdDays: threshold },
      general: { timezone: String(general.timezone ?? 'America/Mexico_City') },
    },
    tax: {
      ratePercent: Number(billing.taxRatePercent ?? 16),
      inclusive: billing.taxInclusive ?? true,
    },
  };
}

/**
 * The near-expiry pricing list exactly as the production source builds it
 * (fetchNearExpiryPricingDates), as of `fetchedAt`: the till's cache may be days old.
 */
async function pricingDates(fetchedAt: Date = new Date()): Promise<NearExpiryPricingDate[]> {
  const res = await fetchNearExpiryPricingDates(testDb as never, threshold, fetchedAt);
  if (!res.ok) throw new Error(`pricing dates: ${res.error.message}`);
  return res.data;
}

beforeAll(async () => {
  if (!hasEnv) return;
  // Before any write: this file seeds, sells into an open caja and deletes audit rows.
  const host = targetHost();
  if (host !== EXPECTED_TARGET) {
    throw new Error(`refusing to run: the Supabase target is ${host}, expected ${EXPECTED_TARGET}`);
  }
  targetOk = true;
  const settings = await loadSettings();
  if (!settings.tax.inclusive) {
    // storedSubtotal() compares the stored line sum with the total, which only holds when tax is inclusive
    throw new Error(
      'this file supports a tax-inclusive database only (tax-exclusive mode is not covered)'
    );
  }

  const catA = await seedCategory('A');
  const catB = await seedCategory('B');
  const catW = await seedCategory('W');
  const catE = await seedCategory('E');
  const catN = await seedCategory('N');
  const catBundle = await seedCategory('bundle');
  const catMix = await seedCategory('mix');
  const cat3x2 = await seedCategory('3x2');
  const catPct = await seedCategory('pct');

  const p: Record<string, string> = {};
  p['a1'] = await seedProduct({ key: 'a1', categoryId: catA, price: 10.05 });
  p['a2'] = await seedProduct({ key: 'a2', categoryId: catA, price: 3.33 });
  p['a3'] = await seedProduct({ key: 'a3', categoryId: catB, price: 0.99 });
  p['a4'] = await seedProduct({ key: 'a4', categoryId: catB, price: 24.5 });
  p['a5'] = await seedProduct({ key: 'a5', categoryId: catB, price: 7 });
  p['w1'] = await seedProduct({ key: 'w1', categoryId: catW, price: 12.35, weighted: true });
  p['w2'] = await seedProduct({ key: 'w2', categoryId: catW, price: 5, weighted: true });
  p['w3'] = await seedProduct({ key: 'w3', categoryId: catW, price: 9.99, weighted: true });
  p['w4'] = await seedProduct({ key: 'w4', categoryId: catW, price: 5, weighted: true });
  p['wE'] = await seedProduct({
    key: 'wE',
    categoryId: catW,
    price: 18.4,
    weighted: true,
    expiryInDays: threshold - 2,
  });
  p['eIn'] = await seedProduct({
    key: 'eIn',
    categoryId: catE,
    price: 20,
    expiryInDays: threshold,
  });
  p['eOut'] = await seedProduct({
    key: 'eOut',
    categoryId: catE,
    price: 20,
    expiryInDays: threshold + 1,
  });
  p['eIn1'] = await seedProduct({
    key: 'eIn1',
    categoryId: catE,
    price: 13.37,
    expiryInDays: threshold - 1,
  });
  p['eFar'] = await seedProduct({
    key: 'eFar',
    categoryId: catE,
    price: 9,
    expiryInDays: threshold + 40,
  });
  // no promotion anywhere near these: the tier is the only thing that can change their price
  p['n1'] = await seedProduct({ key: 'n1', categoryId: catN, price: 20, expiryInDays: threshold });
  p['n2'] = await seedProduct({
    key: 'n2',
    categoryId: catN,
    price: 20,
    expiryInDays: threshold + 1,
  });
  p['b1'] = await seedProduct({ key: 'b1', categoryId: catBundle, price: 7.5 });
  p['b2'] = await seedProduct({ key: 'b2', categoryId: catBundle, price: 5.55 });
  p['m1'] = await seedProduct({ key: 'm1', categoryId: catMix, price: 4.99 });
  p['m2'] = await seedProduct({ key: 'm2', categoryId: catMix, price: 6.49 });
  p['m3'] = await seedProduct({ key: 'm3', categoryId: catMix, price: 2.25 });
  p['t1'] = await seedProduct({ key: 't1', categoryId: cat3x2, price: 8.4 });
  p['t2'] = await seedProduct({ key: 't2', categoryId: cat3x2, price: 3.15 });
  p['q1'] = await seedProduct({ key: 'q1', categoryId: catPct, price: 15.5 });
  p['q2'] = await seedProduct({ key: 'q2', categoryId: catPct, price: 9.99 });

  // per-line promotions: every kind of tie, cap and window the SQL candidate pool has
  await seedPromotion({ key: 'catA 12.5%', type: 'percent', value: 12.5, categoryIds: [catA] });
  await seedPromotion({ key: 'a2 fixed 1.50', type: 'fixed', value: 1.5, productIds: [p['a2']] });
  await seedPromotion({
    key: 'a3 fixed 5 (above price)',
    type: 'fixed',
    value: 5,
    productIds: [p['a3']],
  });
  await seedPromotion({
    key: 'a4 20% all-week all-day',
    type: 'percent',
    value: 20,
    productIds: [p['a4']],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startTime: '00:00:00',
    endTime: '23:59:59',
  });
  // WR-04: an empty daysOfWeek is never live, on either side
  await seedPromotion({
    key: 'a5 90% never (empty days)',
    type: 'percent',
    value: 90,
    productIds: [p['a5']],
    daysOfWeek: [],
  });
  await seedPromotion({ key: 'w1 33%', type: 'percent', value: 33, productIds: [p['w1']] });
  await seedPromotion({ key: 'w1 fixed 2', type: 'fixed', value: 2, productIds: [p['w1']] });
  await seedPromotion({ key: 'w2 fixed 0.75', type: 'fixed', value: 0.75, productIds: [p['w2']] });
  await seedPromotion({ key: 'w2 10%', type: 'percent', value: 10, productIds: [p['w2']] });
  await seedPromotion({ key: 'catE 12%', type: 'percent', value: 12, categoryIds: [catE] });
  await seedPromotion({ key: 'wE fixed 1', type: 'fixed', value: 1, productIds: [p['wE']] });

  // combos: bundle price, mix and match (any 3 of a category), 3x2, percent off a bundle
  await seedPromotion({
    key: 'combo bundle b1+b2 at 11',
    kind: 'combo',
    type: 'bundle_price',
    value: 11,
    slots: [
      { quantity: 1, productId: p['b1'] },
      { quantity: 1, productId: p['b2'] },
    ],
  });
  await seedPromotion({
    key: 'combo mix any 3 of mix at 10',
    kind: 'combo',
    type: 'bundle_price',
    value: 10,
    slots: [{ quantity: 3, categoryId: catMix }],
  });
  await seedPromotion({
    key: 'combo 3x2 on 3x2',
    kind: 'combo',
    type: 'cheapest_free',
    value: 1,
    slots: [{ quantity: 3, categoryId: cat3x2 }],
  });
  await seedPromotion({
    key: 'combo 15% off q1+q2',
    kind: 'combo',
    type: 'percent',
    value: 15,
    slots: [
      { quantity: 1, productId: p['q1'] },
      { quantity: 1, productId: p['q2'] },
    ],
  });

  // fixtures the RPC needs: an active cashier-or-above with an open shift, an open caja
  const { data: staff } = await db
    .from('profiles')
    .select('id')
    .in('role', ['cashier', 'manager', 'admin'])
    .eq('is_active', true)
    .limit(1)
    .single();
  if (!staff) throw new Error('no active staff profile on the local stack');
  const { data: openShift } = await db
    .from('shifts')
    .select('id')
    .eq('staff_id', staff.id)
    .is('clock_out', null)
    .limit(1)
    .maybeSingle();
  let shiftId = openShift?.id as string | undefined;
  if (!shiftId) {
    const s = await db
      .from('shifts')
      .insert({ staff_id: staff.id, opening_cash: 0 })
      .select('id')
      .single();
    throwIf(s.error, 'shift');
    shiftId = s.data.id as string;
    created.shiftId = shiftId;
  }
  const { data: openCaja } = await db
    .from('caja_sessions')
    .select('id')
    .eq('status', 'open')
    .limit(1)
    .maybeSingle();
  let cajaId = openCaja?.id as string | undefined;
  if (!cajaId) {
    const c = await db
      .from('caja_sessions')
      .insert({ opened_by: staff.id, opening_cash: 0 })
      .select('id')
      .single();
    throwIf(c.error, 'caja');
    cajaId = c.data.id as string;
    created.cajaId = cajaId;
  }

  const { data: productRows } = await db.from('products').select('*').in('id', created.productIds);
  const products: Record<string, Product> = {};
  for (const [key, id] of Object.entries(p)) {
    const row = (productRows as any[]).find(r => r.id === id);
    const mapped = mapProductRow({ ...row, category: null, product_modifiers: null });
    if (!mapped.ok) throw new Error(`map product ${key}`);
    products[key] = mapped.data;
  }
  const { data: catRows } = await db.from('categories').select('id, parent_id, combo_eligible');
  const categories = new Map<string, ComboCategoryLookup>(
    (catRows as any[]).map(c => [c.id, { comboEligible: c.combo_eligible, parentId: c.parent_id }])
  );

  world = {
    products,
    promotions: await loadPromotions(),
    ...settings,
    categories,
    nearExpiry: await pricingDates(),
    staffId: staff.id as string,
    shiftId,
    cajaId,
  };
}, 60_000);

afterAll(async () => {
  if (!hasEnv || !targetOk) return;
  const auditEntityIds: string[] = [...created.promotionIds];
  if (createdTicketIds.length > 0) {
    await db.from('manager_approvals').delete().in('id', createdTicketIds);
  }
  for (const tabId of created.tabIds) {
    const { data: payments } = await db.from('payments').select('id').eq('tab_id', tabId);
    auditEntityIds.push(...((payments ?? []) as any[]).map(p => p.id));
    await db.from('payments').delete().eq('tab_id', tabId);
    const { data: orders } = await db.from('orders').select('id').eq('tab_id', tabId);
    const orderIds = ((orders ?? []) as any[]).map(o => o.id);
    if (orderIds.length > 0) {
      await db.from('order_items').delete().in('order_id', orderIds);
      await db.from('orders').delete().in('id', orderIds);
    }
    await db.from('tabs').delete().eq('id', tabId);
  }
  if (created.productIds.length > 0) {
    await db.from('stock_movements').delete().in('product_id', created.productIds);
  }
  for (const id of created.promotionIds) {
    await db.from('promotion_targets').delete().eq('promotion_id', id);
    await db.from('promotion_combo_slots').delete().eq('promotion_id', id);
    await db.from('promotions').delete().eq('id', id);
  }
  for (const id of created.productIds) {
    await db.from('inventory').delete().eq('product_id', id);
    await db.from('products').delete().eq('id', id);
  }
  for (const id of created.categoryIds) await db.from('categories').delete().eq('id', id);
  if (created.cajaId) await db.from('caja_sessions').delete().eq('id', created.cajaId);
  if (created.shiftId) await db.from('shifts').delete().eq('id', created.shiftId);
  // The audit rows the sales and the promotion deletes wrote (payment.process, promotion.apply,
  // promotion.deactivate) are keyed by payment / promotion id. They are removed last, because the
  // promotion deletes above write promotion.deactivate rows of their own.
  // the near-expiry tier writes promotion.apply with a NULL entity id: find those by their product
  const { data: tierRows } = await db
    .from('audit_logs')
    .select('id, before, after')
    .eq('action', 'promotion.apply')
    .is('entity_id', null)
    .gte('created_at', startedAt);
  const mine = new Set<string>(created.productIds);
  const tierIds = ((tierRows ?? []) as any[])
    .filter(r => mine.has((r.after ?? r.before)?.productId))
    .map(r => r.id as string);
  for (let i = 0; i < tierIds.length; i += 100) {
    const { error } = await db
      .from('audit_logs')
      .delete()
      .in('id', tierIds.slice(i, i + 100));
    expect(error).toBeNull();
  }
  for (let i = 0; i < auditEntityIds.length; i += 100) {
    const { error } = await db
      .from('audit_logs')
      .delete()
      .in('entity_id', auditEntityIds.slice(i, i + 100));
    expect(error).toBeNull();
  }
}, 120_000);

// ---------------------------------------------------------------------------------------------
// The client side: scan -> cart -> combos -> total, exactly as the checkout screen composes it.
// ---------------------------------------------------------------------------------------------

type Scan =
  | { kind: 'unit'; key: string; quantity: number }
  | { kind: 'weight'; key: string; grams: number };

function describeScans(scans: Scan[]): string {
  return scans
    .map(s => (s.kind === 'unit' ? `${s.key}x${s.quantity}` : `${s.key}@${s.grams}g`))
    .join(', ');
}

/** CheckoutPanel.addProductTimes / ProductGrid + WeightEntryDialog, against the loaded catalog. */
function ringUp(
  scans: Scan[],
  now: Date,
  nearExpiry: NearExpiryPricingDate[] = world.nearExpiry
): void {
  const cart = useCartStore.getState();
  cart.clearCart();
  for (const scan of scans) {
    const product = world.products[scan.key]!;
    if (scan.kind === 'unit') {
      const match = resolveProductPromotion(
        product,
        world.promotions,
        world.settings,
        nearExpiry,
        now
      );
      for (let i = 0; i < scan.quantity; i += 1) {
        cart.addItem(product, [], match?.discountedUnitPrice, match?.promotionId ?? null);
      }
    } else {
      // the server discounts the LINE price, so the promotion is resolved for the weight
      const match = resolveProductPromotion(
        product,
        world.promotions,
        world.settings,
        nearExpiry,
        now,
        scan.grams
      );
      cart.addWeightedItem(
        product,
        scan.grams,
        match?.discountedUnitPrice,
        match?.promotionId ?? null
      );
    }
  }
}

/** The total the payment form shows (and sends as p_amount) for the cart as rung up. */
function clientTotal(now: Date): number {
  const cart = useCartStore.getState();
  cart.setComboResult(
    evaluateCombos(
      cartItemsToComboLines(cart.items),
      world.promotions,
      now,
      world.settings.general.timezone,
      world.categories
    )
  );
  const tab = cartItemsToSyntheticTab(cart.items, world.staffId, world.shiftId, 'parity-tab');
  const subtotal = tab.items.reduce((sum, item) => sum + calculateLineTotal(item), 0);
  return formTotal(subtotal, 0, cart.comboNetSavings(), world.tax.ratePercent, world.tax.inclusive);
}

let saleSeq = 0;

/** What useCheckoutSale sends, straight to the RPC. Returns the RPC's envelope. */
async function callSale(
  amount: number
): Promise<{ ok: boolean; code?: string; message?: string; tabId?: string }> {
  const items = cartItemsToRpcItems(useCartStore.getState().items).map(i => ({
    product_id: i.productId,
    quantity: i.quantity,
    unit_price: i.unitPrice,
    modifier_ids: i.modifierIds,
    modifier_price_delta: i.modifierPriceDelta,
    notes: i.notes ?? '',
    ...(i.weightGrams !== undefined ? { weight_grams: i.weightGrams } : {}),
  }));
  const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
    p_staff_id: world.staffId,
    p_shift_id: world.shiftId,
    p_caja_session_id: world.cajaId,
    p_items: items,
    p_idempotency_key: `${tag}-${(saleSeq += 1)}`,
    p_method: 'cash',
    p_amount: amount,
    p_tendered_amount: amount,
    p_manager_override: false,
  } as never);
  if (error) throw new Error(`rpc transport error: ${error.message}`);
  const res = data as { ok: boolean; code?: string; message?: string; tabId?: string };
  if (res.tabId) created.tabIds.push(res.tabId);
  return res;
}

/**
 * What the server STORED for the sale: the sum of the order_items it derived (unit price plus
 * modifiers, times quantity), to the cent. The payment row holds the client's amount, and the RPC
 * accepts a client amount up to 0.01 over its own derived total, so accepted-or-refused alone is
 * blind to a client total one cent too HIGH; this is what it is compared with.
 */
async function storedSubtotal(tabId: string): Promise<number> {
  const { data: orders } = await db.from('orders').select('id').eq('tab_id', tabId);
  const { data: items, error } = await db
    .from('order_items')
    .select('unit_price, modifier_price_delta, quantity')
    .in(
      'order_id',
      ((orders ?? []) as any[]).map(o => o.id)
    );
  throwIf(error, 'stored items');
  const cents = ((items ?? []) as any[]).reduce<number>(
    (sum, i) =>
      sum +
      Math.round((Number(i.unit_price) + Number(i.modifier_price_delta)) * 100) *
        Number(i.quantity),
    0
  );
  return cents / 100;
}

async function addProduct(key: string, price: number, weighted: boolean): Promise<string> {
  // its own category: the seeded category-level promotions must not touch it
  const catId = await seedCategory(`own ${key}`);
  const id = await seedProduct({ key, categoryId: catId, price, weighted });
  const { data: row } = await db.from('products').select('*').eq('id', id).single();
  const mapped = mapProductRow({ ...row, category: null, product_modifiers: null });
  if (!mapped.ok) throw new Error(`map product ${key}`);
  world.products[key] = mapped.data;
  return id;
}

/** A refused sale leaves no payment, tab or order behind for its idempotency key. */
async function expectNothingStored(idempotencyKey: string): Promise<void> {
  const pay = await db.from('payments').select('id').like('idempotency_key', `${idempotencyKey}%`);
  expect(pay.data ?? []).toHaveLength(0);
}


/** An approval ticket for the sale's caller, written as verify_staff_pin would (single use, unconsumed). */
async function overrideTicket(): Promise<{ id: string; approverId: string }> {
  const { data: approver } = await db
    .from('profiles')
    .select('id')
    .eq('role', 'admin')
    .eq('is_active', true)
    .limit(1)
    .single();
  const { data, error } = await db
    .from('manager_approvals')
    .insert({ caller_id: world.staffId, action: 'apply_custom_discount', approver_ids: [approver.id] })
    .select('id')
    .single();
  throwIf(error, 'approval ticket');
  createdTicketIds.push(data.id);
  return { id: data.id as string, approverId: approver.id as string };
}
const createdTicketIds: string[] = [];

async function ticketConsumed(id: string): Promise<boolean> {
  const { data } = await db.from('manager_approvals').select('consumed_at').eq('id', id).single();
  return data.consumed_at !== null;
}

/** The sale as the till sends it under a manager override (optionally with an ad-hoc discount). */
async function callOverrideSale(
  amount: number,
  ticket: { id: string; approverId: string },
  adHoc?: { type: 'percent' | 'fixed'; value: number }
): Promise<{ ok: boolean; code?: string; message?: string; tabId?: string }> {
  const items = cartItemsToRpcItems(useCartStore.getState().items).map(i => ({
    product_id: i.productId,
    quantity: i.quantity,
    unit_price: i.unitPrice,
    modifier_ids: i.modifierIds,
    modifier_price_delta: i.modifierPriceDelta,
    notes: i.notes ?? '',
    ...(i.weightGrams !== undefined ? { weight_grams: i.weightGrams } : {}),
  }));
  const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
    p_staff_id: world.staffId,
    p_shift_id: world.shiftId,
    p_caja_session_id: world.cajaId,
    p_items: items,
    p_idempotency_key: `${tag}-${(saleSeq += 1)}`,
    p_method: 'cash',
    p_amount: amount,
    p_tendered_amount: amount,
    p_manager_override: true,
    p_approval_id: ticket.id,
    p_approver_id: ticket.approverId,
    ...(adHoc
      ? {
          p_discount_scope: 'all',
          p_discount_type: adHoc.type,
          p_discount_value: adHoc.value,
          p_discount_amount: 0,
        }
      : {}),
  } as never);
  if (error) throw new Error(`rpc transport error: ${error.message}`);
  const res = data as { ok: boolean; code?: string; message?: string; tabId?: string };
  if (res.tabId) created.tabIds.push(res.tabId);
  return res;
}


/** Rings up the scans, quotes the client total, asks the RPC to accept exactly that, reads back what it stored. */
async function parity(scans: Scan[], pricing?: NearExpiryPricingDate[]) {
  const now = new Date();
  ringUp(scans, now, pricing);
  const total = clientTotal(now);
  const res = await callSale(total);
  const stored = res.ok && res.tabId ? await storedSubtotal(res.tabId) : undefined;
  return { total, res, stored, label: `${describeScans(scans)} client total ${total}` };
}

/** Accepted AND stored at exactly the client total (the dev2 database is tax-inclusive, checked in beforeAll). */
function expectAccepted(p: Awaited<ReturnType<typeof parity>>): void {
  expect(p.res.ok, `${p.label} -> ${p.res.code}: ${p.res.message}`).toBe(true);
  expect(p.stored, `${p.label}: the server stored a different total`).toBe(p.total);
}

/** The client total with no near-expiry pricing list at all: what the cart would show without the tier. */
function totalWithoutTier(scans: Scan[]): number {
  const now = new Date();
  ringUp(scans, now, []);
  return clientTotal(now);
}

// ---------------------------------------------------------------------------------------------

describe('offline pricing parity — client total vs process_direct_sale_atomic (integration)', () => {
  itDb('targets the dev2 local stack (127.0.0.1:56321), never another database', () => {
    // beforeAll already refused to write anywhere else; this keeps the fact visible in the report
    expect(targetHost()).toBe(EXPECTED_TARGET);
    expect(targetOk).toBe(true);
  });

  itDb(
    'for generated carts the client total equals expectedTotal accepted by process_direct_sale_atomic with no AMOUNT_MISMATCH',
    async () => {
      const unitKeys = [
        'a1',
        'a2',
        'a3',
        'a4',
        'a5',
        'eIn',
        'eOut',
        'eIn1',
        'eFar',
        'b1',
        'b2',
        'm1',
        'm2',
        'm3',
        't1',
        't2',
        'q1',
        'q2',
      ];
      const weightKeys = ['w1', 'w2', 'w3', 'w4', 'wE'];
      const scanArb: fc.Arbitrary<Scan> = fc.oneof(
        {
          arbitrary: fc.record({
            kind: fc.constant('unit' as const),
            key: fc.constantFrom(...unitKeys),
            quantity: fc.integer({ min: 1, max: 4 }),
          }),
          weight: 3,
        },
        {
          arbitrary: fc.record({
            kind: fc.constant('weight' as const),
            key: fc.constantFrom(...weightKeys),
            grams: fc.integer({ min: 1, max: 5000 }),
          }),
          weight: 2,
        }
      );
      await fc.assert(
        fc.asyncProperty(fc.array(scanArb, { minLength: 1, maxLength: 5 }), async scans => {
          const now = new Date();
          ringUp(scans, now);
          const total = clientTotal(now);
          // F-ZERO (see 'loose-weight lines'): a fully discounted 0.00 sale agrees on the total but the
          // payment step refuses it, online too. Not a parity question, so those carts are discarded.
          fc.pre(total > 0);
          const res = await callSale(total);
          if (!res.ok) {
            throw new Error(
              `${describeScans(scans)} client total ${total} -> ${res.code}: ${res.message}`
            );
          }
          const stored = await storedSubtotal(res.tabId!);
          if (stored !== total) {
            throw new Error(
              `${describeScans(scans)} client total ${total}, the server stored ${stored}`
            );
          }
        }),
        { numRuns: PARITY_RUNS, seed: PARITY_SEED, verbose: 1 }
      );
    },
    240_000
  );

  itDb('loose-weight lines', async () => {
    // line price rounds like SQL ROUND (half away from zero): 5.00/kg x 205 g = 1.025, x 207 g = 1.035
    expectAccepted(
      await parity([
        { kind: 'weight', key: 'w4', grams: 205 },
        { kind: 'weight', key: 'w4', grams: 207 },
        { kind: 'weight', key: 'w4', grams: 43 },
      ])
    );
    // the discount is taken on the LINE price: a fixed one once per line, a percent one rounded on the line
    expectAccepted(await parity([{ kind: 'weight', key: 'w1', grams: 500 }]));
    expectAccepted(await parity([{ kind: 'weight', key: 'w1', grams: 375 }]));
    expectAccepted(await parity([{ kind: 'weight', key: 'w2', grams: 1250 }]));
    expectAccepted(await parity([{ kind: 'weight', key: 'w2', grams: 160 }]));
    // 20 g at 5/kg is a 0.10 line; the fixed 0.75/kg takes 0.015 -> 0.02 (it used to be a free line, F-ZERO)
    const small = await parity([{ kind: 'weight', key: 'w2', grams: 20 }]);
    expect(small.total).toBe(0.08);
    expectAccepted(small);
    expectAccepted(await parity([{ kind: 'weight', key: 'w3', grams: 2345 }]));
  });

  itDb('combo bundle, mix-and-match, 3x2, percent-off-bundle', async () => {
    expectAccepted(
      await parity([
        { kind: 'unit', key: 'b1', quantity: 1 },
        { kind: 'unit', key: 'b2', quantity: 1 },
      ])
    );
    expectAccepted(
      await parity([
        { kind: 'unit', key: 'b1', quantity: 2 },
        { kind: 'unit', key: 'b2', quantity: 3 },
      ])
    );
    expectAccepted(
      await parity([
        { kind: 'unit', key: 'm1', quantity: 1 },
        { kind: 'unit', key: 'm2', quantity: 1 },
        { kind: 'unit', key: 'm3', quantity: 2 },
      ])
    );
    expectAccepted(
      await parity([
        { kind: 'unit', key: 't1', quantity: 2 },
        { kind: 'unit', key: 't2', quantity: 4 },
      ])
    );
    expectAccepted(
      await parity([
        { kind: 'unit', key: 'q1', quantity: 2 },
        { kind: 'unit', key: 'q2', quantity: 1 },
      ])
    );
    // all four at once, with a promoted and a weighted line beside them
    expectAccepted(
      await parity([
        { kind: 'unit', key: 'b1', quantity: 1 },
        { kind: 'unit', key: 'b2', quantity: 1 },
        { kind: 'unit', key: 'm1', quantity: 3 },
        { kind: 'unit', key: 't1', quantity: 3 },
        { kind: 'unit', key: 'q1', quantity: 1 },
        { kind: 'unit', key: 'q2', quantity: 1 },
        { kind: 'unit', key: 'a2', quantity: 2 },
        { kind: 'weight', key: 'w1', grams: 700 },
      ])
    );
  });

  itDb('near-expiry tier at the threshold day', async () => {
    // n1 expires on D+T (D = the store's date): inside the tier (<=). n2 expires on D+T+1: outside.
    // Neither has a promotion, so the tier is the only thing that can change their price.
    const n1 = [{ kind: 'unit', key: 'n1', quantity: 1 } as const];
    const n2 = [{ kind: 'unit', key: 'n2', quantity: 1 } as const];
    const inTier = await parity(n1);
    expectAccepted(inTier);
    expect(
      inTier.total,
      'the tier must lower the price (a 0 % setting would pass vacuously)'
    ).toBeLessThan(totalWithoutTier(n1));
    const outside = await parity(n2);
    expectAccepted(outside);
    expect(outside.total).toBe(totalWithoutTier(n2));
    // the same boundary with a promotion in play, a day inside, a far date, and a weighted line
    expectAccepted(await parity([{ kind: 'unit', key: 'eIn', quantity: 1 }]));
    expectAccepted(await parity([{ kind: 'unit', key: 'eOut', quantity: 1 }]));
    expectAccepted(
      await parity([
        { kind: 'unit', key: 'eIn1', quantity: 2 },
        { kind: 'unit', key: 'eFar', quantity: 1 },
      ])
    );
    expectAccepted(await parity([{ kind: 'weight', key: 'wE', grams: 640 }]));
  });

  itDb(
    "a product that enters the near-expiry window by the server's date is priced with the tier",
    async () => {
      // The till's list was fetched 7 days ago, the oldest a restored catalog can be (PERSIST_MAX_AGE_MS).
      // n1 expires on D+T: when the list was fetched it was 7 days short of the tier; now the server
      // (the store date = D) gives it the tier. The production source must have carried it anyway.
      const cached = await pricingDates(new Date(Date.now() - 7 * DAY_MS));
      expect(cached.map(d => d.productId)).toContain(world.products['n1']!.id);
      const n1 = [{ kind: 'unit', key: 'n1', quantity: 1 } as const];
      const priced = await parity(n1, cached);
      expectAccepted(priced);
      expect(priced.total).toBeLessThan(totalWithoutTier(n1));
      // one day further out is in the list too, and is still outside the tier
      const outside = await parity([{ kind: 'unit', key: 'n2', quantity: 1 }], cached);
      expectAccepted(outside);
      expect(outside.total).toBe(totalWithoutTier([{ kind: 'unit', key: 'n2', quantity: 1 }]));
    }
  );

  /**
   * Runs `fn` with settings.general.timezone set to `tz` on dev2 and on the till's settings, and
   * restores it in finally (verified by a query). Shared dev2: the window is printed.
   */
  async function withStoreTimezone(tz: string, fn: () => Promise<void>): Promise<void> {
    const before = await db.from('settings').select('value').eq('key', 'general').single();
    throwIf(before.error, 'read general');
    const original = before.data.value as Record<string, unknown>;
    const startedAt = new Date().toISOString();
    const savedWorldTz = world.settings.general.timezone;
    const savedStoreTz = storeTz;
    const savedToday = serverToday;
    try {
      throwIf(
        (
          await db
            .from('settings')
            .update({ value: { ...original, timezone: tz } })
            .eq('key', 'general')
        ).error,
        'set timezone'
      );
      world.settings.general.timezone = tz;
      storeTz = tz;
      await fn();
    } finally {
      world.settings.general.timezone = savedWorldTz;
      storeTz = savedStoreTz;
      serverToday = savedToday;
      throwIf(
        (await db.from('settings').update({ value: original }).eq('key', 'general')).error,
        'restore general'
      );
      const after = await db.from('settings').select('value').eq('key', 'general').single();
      expect(after.data.value).toEqual(original);
      process.stdout.write(
        `settings.general.timezone window ${startedAt} .. ${new Date().toISOString()}\n`
      );
    }
  }

  /** The first candidate zone whose date right now is not one of `notDates`. */
  function zoneWithOtherDate(candidates: string[], notDates: string[]): string {
    const found = candidates.find(z => !notDates.includes(storeLocalDate(new Date(), z)));
    if (!found) throw new Error('no candidate zone has a date different from the reference dates');
    return found;
  }

  type TierKey = 'in' | 'out' | 'dayIn' | 'far';

  /** Four products priced by the tier alone: inside (D+T), outside (D+T+1), a day in (D+T-1) and far out. */
  async function seedTierProducts(prefix: string): Promise<Record<TierKey, string>> {
    const days: Record<TierKey, number> = {
      in: threshold,
      out: threshold + 1,
      dayIn: threshold - 1,
      far: threshold + 40,
    };
    const catId = await seedCategory(`${prefix} tier`);
    const made = {} as Record<TierKey, string>;
    for (const name of Object.keys(days) as TierKey[]) {
      const key = `${prefix}-${name}`;
      const id = await seedProduct({ key, categoryId: catId, price: 20, expiryInDays: days[name] });
      const { data: row } = await db.from('products').select('*').eq('id', id).single();
      const mapped = mapProductRow({ ...row, category: null, product_modifiers: null });
      if (!mapped.ok) throw new Error(`map product ${key}`);
      world.products[key] = mapped.data;
      made[name] = key;
    }
    return made;
  }

  itDb("near-expiry tier at the threshold day, counted on the store's date", async () => {
    const utcToday = new Date().toISOString().slice(0, 10);
    const tz = zoneWithOtherDate(['Pacific/Kiritimati', 'Etc/GMT+12'], [utcToday]);
    await withStoreTimezone(tz, async () => {
      const k = await seedTierProducts('tzStore');
      expect(storeLocalDate(new Date(), tz)).not.toBe(utcToday);
      const list = await pricingDates();
      const inScan = [{ kind: 'unit', key: k.in, quantity: 1 } as const];
      const outScan = [{ kind: 'unit', key: k.out, quantity: 1 } as const];
      const inTier = await parity(inScan, list);
      expectAccepted(inTier);
      expect(inTier.total, 'D+T on the store date is inside the tier').toBeLessThan(
        totalWithoutTier(inScan)
      );
      const outside = await parity(outScan, list);
      expectAccepted(outside);
      expect(outside.total, 'D+T+1 on the store date is outside the tier').toBe(
        totalWithoutTier(outScan)
      );
    });
  });

  itDb('the client and the RPC agree on that day for generated carts', async () => {
    const utcToday = new Date().toISOString().slice(0, 10);
    const tz = zoneWithOtherDate(['Pacific/Kiritimati', 'Etc/GMT+12'], [utcToday]);
    await withStoreTimezone(tz, async () => {
      const k = await seedTierProducts('tzGen');
      const list = await pricingDates();
      const names = Object.values(k);
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({ key: fc.constantFrom(...names), quantity: fc.integer({ min: 1, max: 4 }) }),
            { minLength: 1, maxLength: 4 }
          ),
          async lines => {
            const p = await parity(
              lines.map(l => ({ kind: 'unit' as const, ...l })),
              list
            );
            if (!p.res.ok) throw new Error(`${p.label} -> ${p.res.code}: ${p.res.message}`);
            if (p.stored !== p.total) throw new Error(`${p.label}, the server stored ${p.stored}`);
          }
        ),
        { numRuns: 15, seed: PARITY_SEED }
      );
    });
  });

  itDb(
    'an unknown timezone in settings falls back to America/Mexico_City on the server and on the till',
    async () => {
      for (const bad of ['Not/A_Zone', '']) {
        await withStoreTimezone(bad, async () => {
          storeTz = 'America/Mexico_City'; // dated on the store date the fallback gives
          const k = await seedTierProducts(`tzBad${bad === '' ? 'Blank' : ''}`);
          const list = await pricingDates();
          const inScan = [{ kind: 'unit', key: k.in, quantity: 1 } as const];
          const inTier = await parity(inScan, list);
          expectAccepted(inTier);
          expect(inTier.total).toBeLessThan(totalWithoutTier(inScan));
          expectAccepted(await parity([{ kind: 'unit', key: k.out, quantity: 1 }], list));
        });
      }
    }
  );

  itDb('a lower-case zone name prices the same on till and server', async () => {
    const mexico = storeLocalDate(new Date(), 'America/Mexico_City');
    const tz = zoneWithOtherDate(['pacific/kiritimati', 'etc/gmt+12'], [mexico]);
    await withStoreTimezone(tz, async () => {
      const k = await seedTierProducts('tzLower');
      // no fallback on either side: the tier follows the lower-case zone's date, not Mexico City's
      expect(storeLocalDate(new Date(), tz)).not.toBe(mexico);
      const list = await pricingDates();
      const inScan = [{ kind: 'unit', key: k.in, quantity: 1 } as const];
      const outScan = [{ kind: 'unit', key: k.out, quantity: 1 } as const];
      const inTier = await parity(inScan, list);
      expectAccepted(inTier);
      expect(inTier.total).toBeLessThan(totalWithoutTier(inScan));
      const outside = await parity(outScan, list);
      expectAccepted(outside);
      expect(outside.total).toBe(totalWithoutTier(outScan));
    });
  });

  // Ruling 12: totals are exact, one cent either way is AMOUNT_MISMATCH and nothing is stored.
  itDb(
    'a client total one cent over or under is refused AMOUNT_MISMATCH and nothing is stored',
    async () => {
      const now = new Date();
      ringUp([{ kind: 'unit', key: 'a1', quantity: 1 }], now);
      const total = clientTotal(now);
      const cent = (n: number) => Math.round(n * 100) / 100;
      for (const off of [0.01, -0.01]) {
        const before = saleSeq;
        const res = await callSale(cent(total + off));
        expect(res, `off by ${off}`).toMatchObject({ ok: false, code: 'AMOUNT_MISMATCH' });
        expect(res.tabId).toBeUndefined();
        await expectNothingStored(`${tag}-${before + 1}`);
      }
    }
  );

  itDb('split legs summing one cent off are refused AMOUNT_MISMATCH', async () => {
    const now = new Date();
    ringUp([{ kind: 'unit', key: 'a1', quantity: 1 }], now);
    const total = clientTotal(now);
    const items = cartItemsToRpcItems(useCartStore.getState().items).map(i => ({
      product_id: i.productId,
      quantity: i.quantity,
      unit_price: i.unitPrice,
      modifier_ids: i.modifierIds,
      modifier_price_delta: i.modifierPriceDelta,
      notes: i.notes ?? '',
    }));
    const key = `${tag}-legs-${(saleSeq += 1)}`;
    const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
      p_staff_id: world.staffId,
      p_shift_id: world.shiftId,
      p_caja_session_id: world.cajaId,
      p_items: items,
      p_idempotency_key: key,
      p_legs: [
        { method: 'cash', amount: Math.round(total * 100) / 100, tendered_amount: total },
        { method: 'cash', amount: 0.01, tendered_amount: 0.01 },
      ],
      p_expected_total: total,
    } as never);
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: false, code: 'AMOUNT_MISMATCH' });
    await expectNothingStored(key);
  });

  itDb(
    'a sale that totals 0.00 is refused ZERO_TOTAL_SALE with no tab, payment or stock movement',
    async () => {
      const id = await addProduct('z100', 4.2, false);
      await seedPromotion({ key: 'z100 100%', type: 'percent', value: 100, productIds: [id] });
      world.promotions = await loadPromotions();
      const now = new Date();
      ringUp([{ kind: 'unit', key: 'z100', quantity: 1 }], now);
      expect(clientTotal(now)).toBe(0);
      const before = saleSeq;
      const res = await callSale(0);
      expect(res).toMatchObject({ ok: false, code: 'ZERO_TOTAL_SALE' });
      expect(res.tabId).toBeUndefined();
      await expectNothingStored(`${tag}-${before + 1}`);
      const mv = await db.from('stock_movements').select('id').eq('product_id', id);
      expect(mv.data ?? []).toHaveLength(0);
    }
  );

  // Ruling 11: a fixed promotion on a weighed line is per kilogram.
  itDb('a fixed-amount promotion on a weighed line is per kilogram', async () => {
    const id = await addProduct('kg40', 40, true);
    await seedPromotion({ key: 'kg40 10 off', type: 'fixed', value: 10, productIds: [id] });
    world.promotions = await loadPromotions();
    const p = await parity([{ kind: 'weight', key: 'kg40', grams: 250 }]);
    expectAccepted(p);
    expect(p.total).toBe(7.5);
    expect(p.stored).toBe(7.5);
  });

  itDb('one kilogram weighed as four lines totals the same as one line', async () => {
    const one = await parity([{ kind: 'weight', key: 'kg40', grams: 1000 }]);
    expectAccepted(one);
    const four = await parity(Array.from({ length: 4 }, () => ({ kind: 'weight', key: 'kg40', grams: 250 }) as const));
    expectAccepted(four);
    expect(one.total).toBe(30);
    expect(four.total).toBe(30);
  });

  itDb(
    'a 2 g line with 2.00 off per kilogram gets 0.00 off and a 50 kg line is capped at its price; the below-cost guard still answers',
    async () => {
      const tiny = await addProduct('kgTiny', 40, true);
      await seedPromotion({ key: 'kgTiny 2 off', type: 'fixed', value: 2, productIds: [tiny] });
      const big = await addProduct('kgBig', 40, true);
      await seedPromotion({ key: 'kgBig 60 off', type: 'fixed', value: 60, productIds: [big] });
      world.promotions = await loadPromotions();
      const small = await parity([{ kind: 'weight', key: 'kgTiny', grams: 2 }]);
      expectAccepted(small); // 0.08 line, 0.004 off rounds to 0.00
      expect(small.total).toBe(0.08);
      const capped = await parity([
        { kind: 'weight', key: 'kgBig', grams: 50000 },
        { kind: 'unit', key: 'a1', quantity: 1 },
      ]);
      expectAccepted(capped); // the 50 kg line is free, a1 is the whole total
      // below cost: the guard answers on the server like before, the till is never the judge
      await db.from('inventory').update({ cost_price: 1 }).eq('product_id', big);
      const guarded = await parity([
        { kind: 'weight', key: 'kgBig', grams: 1000 },
        { kind: 'unit', key: 'a1', quantity: 1 },
      ]);
      expect(guarded.res).toMatchObject({ ok: false, code: 'BELOW_COST_REQUIRES_OVERRIDE' });
    }
  );

  // Plan 02d C2: cost is per kilogram, so a weighed line is compared with the cost of its weight.
  itDb('a weighed line is compared with the cost of its weight', async () => {
    const w = await addProduct('wcost', 40, true);
    world.promotions = await loadPromotions();
    await db.from('inventory').update({ cost_price: 30 }).eq('product_id', w);
    // 250 g at 40/kg = 10.00; cost of that weight 7.50 -> accepted (the unscaled guard refused it)
    expectAccepted(await parity([{ kind: 'weight', key: 'wcost', grams: 250 }]));
    await db.from('inventory').update({ cost_price: 50 }).eq('product_id', w);
    // same line, cost of weight 12.50 -> refused
    const dear = await parity([{ kind: 'weight', key: 'wcost', grams: 250 }]);
    expect(dear.res).toMatchObject({ ok: false, code: 'BELOW_COST_REQUIRES_OVERRIDE' });
    // 1000 g at 40.00 against cost 50 -> still refused
    const kg = await parity([{ kind: 'weight', key: 'wcost', grams: 1000 }]);
    expect(kg.res).toMatchObject({ ok: false, code: 'BELOW_COST_REQUIRES_OVERRIDE' });
    // a unit product priced below cost is still refused
    const u = await addProduct('ucost', 10, false);
    await db.from('inventory').update({ cost_price: 20 }).eq('product_id', u);
    const unit = await parity([{ kind: 'unit', key: 'ucost', quantity: 1 }]);
    expect(unit.res).toMatchObject({ ok: false, code: 'BELOW_COST_REQUIRES_OVERRIDE' });
  });

  itDb('a weighed line with no inventory row is never below cost', async () => {
    const w = await addProduct('wnoinv', 40, true);
    await db.from('inventory').delete().eq('product_id', w);
    expectAccepted(await parity([{ kind: 'weight', key: 'wnoinv', grams: 250 }]));
  });

  itDb('with a manager override a refused total gives the approval back', async () => {
    // control: a good override sale spends its ticket, so "unspent" below really is the rollback
    const now = new Date();
    ringUp([{ kind: 'unit', key: 'a1', quantity: 1 }], now);
    const total = clientTotal(now);
    const good = await overrideTicket();
    expect((await callOverrideSale(total, good)).ok).toBe(true);
    expect(await ticketConsumed(good.id)).toBe(true);

    const mismatch = await overrideTicket();
    const m = await callOverrideSale(Math.round((total + 0.01) * 100) / 100, mismatch);
    expect(m).toMatchObject({ ok: false, code: 'DIRECT_SALE_FAILED' });
    expect(m.message).toMatch(/^AMOUNT_MISMATCH:/);
    expect(await ticketConsumed(mismatch.id)).toBe(false);

    ringUp([{ kind: 'unit', key: 'z100', quantity: 1 }], now);
    const zero = await overrideTicket();
    const z = await callOverrideSale(0, zero);
    expect(z).toMatchObject({ ok: false, code: 'DIRECT_SALE_FAILED' });
    expect(z.message).toMatch(/^ZERO_TOTAL_SALE:/);
    expect(await ticketConsumed(zero.id)).toBe(false);
  });

  itDb('tax-exclusive mode: generated carts agree to the cent', async () => {
    const before = await db.from('settings').select('value').eq('key', 'billing').single();
    throwIf(before.error, 'read billing');
    const original = before.data.value as Record<string, unknown>;
    const startedAt = new Date().toISOString();
    try {
      throwIf(
        (
          await db
            .from('settings')
            .update({ value: { ...original, taxInclusive: false, taxRatePercent: 16 } })
            .eq('key', 'billing')
        ).error,
        'flip billing'
      );
      const flipped = await loadSettings();
      expect(flipped.tax.inclusive).toBe(false);
      const saved = world.tax;
      world.tax = flipped.tax;
      try {
        for (const key of ['a1', 'a2', 'a4', 'a5']) {
          for (let q = 1; q <= 9; q += 1) {
            const p = await parity([{ kind: 'unit', key, quantity: q }]);
            expect(p.res.ok, `${p.label} -> ${p.res.code}: ${p.res.message}`).toBe(true);
          }
        }
      } finally {
        world.tax = saved;
      }
    } finally {
      throwIf(
        (await db.from('settings').update({ value: original }).eq('key', 'billing')).error,
        'restore billing'
      );
      const after = await db.from('settings').select('value').eq('key', 'billing').single();
      expect(after.data.value).toEqual(original);
      process.stdout.write(`settings.billing window ${startedAt} .. ${new Date().toISOString()}\n`);
    }
  });

  itDb('tax-exclusive mode at 15%: half-cent ties agree to the cent', async () => {
    const before = await db.from('settings').select('value').eq('key', 'billing').single();
    throwIf(before.error, 'read billing');
    const original = before.data.value as Record<string, unknown>;
    const startedAt = new Date().toISOString();
    try {
      throwIf(
        (
          await db
            .from('settings')
            .update({ value: { ...original, taxInclusive: false, taxRatePercent: 15 } })
            .eq('key', 'billing')
        ).error,
        'flip billing'
      );
      const flipped = await loadSettings();
      expect(flipped.tax).toEqual({ ratePercent: 15, inclusive: false });
      const saved = world.tax;
      world.tax = flipped.tax;
      try {
        // subtotals ending .10/.30/.50/.70/.90 tie at 15%: tax = 0.15 * s has a half cent
        await addProduct('t15', 0.1, false);
        for (const key of ['t15', 'a1', 'a2', 'a4', 'a5']) {
          for (let q = 1; q <= 12; q += 1) {
            const p = await parity([{ kind: 'unit', key, quantity: q }]);
            expect(p.res.ok, `${p.label} -> ${p.res.code}: ${p.res.message}`).toBe(true);
          }
        }
      } finally {
        world.tax = saved;
      }
    } finally {
      throwIf(
        (await db.from('settings').update({ value: original }).eq('key', 'billing')).error,
        'restore billing'
      );
      const after = await db.from('settings').select('value').eq('key', 'billing').single();
      expect(after.data.value).toEqual(original);
      process.stdout.write(`settings.billing window ${startedAt} .. ${new Date().toISOString()}\n`);
    }
  });

  itDb('generated carts with an ad-hoc percent discount agree to the cent', async () => {
    // 20.70 at 5% is a half-cent tie (1.035): the server rounds it up to 1.04
    await addProduct('p2070', 20.7, false);
    const adHocTotal = (now: Date, pct: number): number => {
      ringUp(adHocScans, now);
      const cart = useCartStore.getState();
      cart.setComboResult(
        evaluateCombos(
          cartItemsToComboLines(cart.items),
          world.promotions,
          now,
          world.settings.general.timezone,
          world.categories
        )
      );
      const tab = cartItemsToSyntheticTab(cart.items, world.staffId, world.shiftId, 'parity-tab');
      const subtotal = tab.items.reduce((sum, i) => sum + calculateLineTotal(i), 0);
      const combo = cart.comboNetSavings();
      // the server takes an ad-hoc discount after promotions and combos
      const discount = calculateDiscountAmount(subtotal - combo, 'percent', pct);
      return formTotal(subtotal, discount, combo, world.tax.ratePercent, world.tax.inclusive);
    };
    let adHocScans: Scan[] = [];
    for (const [scans, pct] of [
      [[{ kind: 'unit', key: 'p2070', quantity: 1 }], 5],
      [[{ kind: 'unit', key: 'a1', quantity: 1 }], 15],
      [[{ kind: 'unit', key: 'a2', quantity: 3 }], 7.5],
      [[{ kind: 'unit', key: 'a5', quantity: 5 }], 12.5],
      [[{ kind: 'unit', key: 'a1', quantity: 7 }], 33],
      [[{ kind: 'unit', key: 'a4', quantity: 3 }], 0.5],
      // a combo cart: the percent is taken after the combo saving
      [
        [
          { kind: 'unit', key: 'b1', quantity: 2 },
          { kind: 'unit', key: 'b2', quantity: 3 },
        ],
        10,
      ],
    ] as [Scan[], number][]) {
      adHocScans = scans;
      const total = adHocTotal(new Date(), pct);
      const res = await callOverrideSale(total, await overrideTicket(), { type: 'percent', value: pct });
      expect(res.ok, `${describeScans(scans)} ${pct}% total ${total} -> ${res.code}: ${res.message}`).toBe(true);
    }
  });

  itDb('generated carts with a combo agree to the cent', async () => {
    for (const q of [1, 2, 3, 4]) {
      expectAccepted(
        await parity([
          { kind: 'unit', key: 'b1', quantity: q },
          { kind: 'unit', key: 'b2', quantity: q + 1 },
        ])
      );
    }
  });


  // Ruling 5: a promotion window that closes between quote and call is refused, by design.
  itDb('drift reproduction', async () => {
    const id = await seedPromotion({
      key: 'drift 25% on a1',
      type: 'percent',
      value: 25,
      productIds: [world.products['a1']!.id],
    });
    try {
      world.promotions = await loadPromotions();
      const now = new Date();
      ringUp([{ kind: 'unit', key: 'a1', quantity: 2 }], now);
      const quoted = clientTotal(now);
      expect(quoted).toBeLessThan(2 * 10.05 - 0.5); // the quote really holds the promotion
      // the window closes while the till is offline
      const past = new Date(Date.now() - 3_600_000);
      throwIf(
        (
          await db
            .from('promotions')
            .update({
              starts_at: new Date(Date.now() - 7_200_000).toISOString(),
              ends_at: past.toISOString(),
            })
            .eq('id', id)
        ).error,
        'close window'
      );
      const res = await callSale(quoted);
      expect(res).toMatchObject({ ok: false, code: 'AMOUNT_MISMATCH' });
    } finally {
      world.promotions = await loadPromotions();
    }
  });
});
