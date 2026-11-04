/**
 * Lean Zod schemas for the rows/RPC payloads this app reads.
 * Strict SUBSET of the desktop's src/shared/lib/domain.ts and supabase.types.ts —
 * never add a field here that the DB does not already have (spec rule 2).
 */
import { z } from 'zod';

export const RoleSchema = z.enum(['cashier', 'manager', 'admin', 'kitchen']);
export type Role = z.infer<typeof RoleSchema>;

export const ProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleSchema,
  is_active: z.boolean(),
  locale: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const PaymentMethodSchema = z.enum(['cash', 'card', 'tab_transfer', 'rappi', 'bank_transfer']);

export const PaymentSchema = z.object({
  id: z.string(),
  tab_id: z.string(),
  amount: z.number(),
  method: PaymentMethodSchema,
  status: z.string(),
  is_refund: z.boolean(),
  processed_at: z.string(),
  processed_by: z.string(),
  reference_number: z.string().nullable(),
  discount_amount: z.number().nullable(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const TabSchema = z.object({
  id: z.string(),
  status: z.enum(['open', 'closed', 'paid', 'voided', 'split']),
  staff_id: z.string(),
  customer_name: z.string().nullable(),
  opened_at: z.string(),
  closed_at: z.string().nullable(),
  caja_session_id: z.string().nullable(),
  notes: z.string().nullable(),
});
export type Tab = z.infer<typeof TabSchema>;

export const OrderItemSchema = z.object({
  id: z.string(),
  product_id: z.string(),
  quantity: z.number(),
  unit_price: z.number(),
  discount_amount: z.number().nullable(),
  weight_grams: z.number().nullable(),
  is_deleted: z.boolean(),
  products: z.object({ name: z.string() }).nullable(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const RefundSchema = z.object({
  id: z.string(),
  amount: z.number(),
  reason: z.string(),
  created_at: z.string(),
  created_by: z.string(),
  original_payment_id: z.string(),
});
export type Refund = z.infer<typeof RefundSchema>;

export const ShiftSchema = z.object({
  id: z.string(),
  staff_id: z.string(),
  clock_in: z.string(),
  clock_out: z.string().nullable(),
  opening_cash: z.number(),
  closing_cash: z.number().nullable(),
});
export type Shift = z.infer<typeof ShiftSchema>;

export const CajaSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  opened_at: z.string(),
  opened_by: z.string(),
  closed_at: z.string().nullable(),
  closed_by: z.string().nullable(),
  opening_cash: z.number(),
  closing_cash: z.number().nullable(),
  notes: z.string().nullable(),
});
export type CajaSession = z.infer<typeof CajaSessionSchema>;

export const CajaEntrySchema = z.object({
  id: z.string(),
  caja_session_id: z.string(),
  amount: z.number(),
  concept: z.string(),
  type: z.string(),
  staff_id: z.string(),
  created_at: z.string(),
});
export type CajaEntry = z.infer<typeof CajaEntrySchema>;

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  barcode: z.string().nullable(),
  sku: z.string().nullable(),
  base_price: z.number(),
  is_active: z.boolean(),
  sold_by_weight: z.boolean(),
  category_id: z.string(),
  categories: z.object({ name: z.string() }).nullable().optional(),
});
export type Product = z.infer<typeof ProductSchema>;

export const InventorySchema = z.object({
  id: z.string(),
  product_id: z.string(),
  quantity_on_hand: z.number(),
  low_stock_threshold: z.number(),
  cost_price: z.number().nullable(),
  expiry_date: z.string().nullable(),
  unit: z.string(),
  products: ProductSchema.nullable(),
});
export type InventoryRow = z.infer<typeof InventorySchema>;

export const StockMovementSchema = z.object({
  id: z.string(),
  product_id: z.string().nullable(),
  quantity_delta: z.number(),
  reason: z.string(),
  notes: z.string().nullable(),
  staff_id: z.string(),
  created_at: z.string(),
});
export type StockMovement = z.infer<typeof StockMovementSchema>;

export const BankTransferSchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  status: z.string(),
  customer_phone: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string(),
  confirmed_at: z.string().nullable(),
  confirmed_by: z.string().nullable(),
  disputed_at: z.string().nullable(),
  disputed_by: z.string().nullable(),
  dispute_reason: z.string().nullable(),
});
export type BankTransfer = z.infer<typeof BankTransferSchema>;

export const AuditLogSchema = z.object({
  id: z.string(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable(),
  actor_id: z.string().nullable(),
  created_at: z.string(),
  source: z.string(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

// ---- Report RPC envelopes: { ok: boolean, rows?: [...] } ----

export const ReportEnvelope = <T extends z.ZodType>(row: T) =>
  z.object({ ok: z.boolean(), rows: z.array(row).optional() });

export const ProductSalesRowSchema = z.object({
  productId: z.string(),
  productName: z.string().nullable(),
  categoryName: z.string().nullable(),
  units: z.number(),
  revenue: z.number(),
  costTotal: z.number().nullable(),
  margin: z.number().nullable(),
  marginPct: z.number().nullable(),
});
export type ProductSalesRow = z.infer<typeof ProductSalesRowSchema>;

export const CategoryRevenueRowSchema = z.object({
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  unitsSold: z.number(),
  orderCount: z.number(),
  revenue: z.number(),
});
export type CategoryRevenueRow = z.infer<typeof CategoryRevenueRowSchema>;

export const HourlyRowSchema = z.object({
  hour: z.number(),
  orderCount: z.number(),
  revenue: z.number(),
  dayOfWeek: z.number(),
});
export type HourlyRow = z.infer<typeof HourlyRowSchema>;

export const PaymentMethodRowSchema = z.object({
  cajaSessionId: z.string().nullable(),
  method: PaymentMethodSchema,
  legCount: z.number(),
  grossAmount: z.number(),
  isRollup: z.boolean(),
});
export type PaymentMethodRow = z.infer<typeof PaymentMethodRowSchema>;

// settings.key = 'near_expiry' → value JSON
export const NearExpirySettingsSchema = z.object({ thresholdDays: z.number().int().default(14) });
// settings.key = 'general' → value JSON
export const GeneralSettingsSchema = z.object({ barName: z.string().default('Store') });
