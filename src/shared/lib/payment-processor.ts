/**
 * Client-side payment orchestration — calls Supabase Edge `process-payment`
 * with idempotency keys (secrets stay server-side).
 */

import type { DiscountScope, DiscountType, PaymentMethod } from '@shared/lib/domain';
import { generateIdempotencyKey } from '@shared/lib/domain-helpers';
import {
  callProcessPayment,
  callProcessSplitPayment,
  type ProcessPaymentSuccess,
  type ProcessSplitPaymentSuccess,
} from '@shared/lib/edge-function-contracts';
import { ok, type Result } from '@shared/lib/result';
import type { AppError } from '@shared/lib/supabase-contracts';

export interface DiscountInfo {
  scope: DiscountScope;
  type: DiscountType;
  value: number;
  amount: number;
  /** Phase 27 (PROMO-05/07): manager-PIN authorization for the ad-hoc discount and/or the below-cost floor-guard override. */
  managerOverride: boolean;
  /**
   * Phase 27 Plan 08 (G-27-13): the PIN of the staff member who matched in
   * ManagerPinDialog — threaded to the RPC so the server can independently
   * re-verify the authorizing identity from the entered PIN itself, rather
   * than trusting the currently logged-in staff's own session identity.
   */
  managerPin: string | undefined;
}

export type CashPaymentResult = {
  paymentId: string;
  changeAmount: number;
  receiptData: ProcessPaymentSuccess['receiptData'];
};

export type CardPaymentResult = {
  paymentId: string;
  receiptData: ProcessPaymentSuccess['receiptData'];
};

export type PlatformPaymentResult = {
  paymentId: string;
  receiptData: ProcessPaymentSuccess['receiptData'];
};

export async function processCashPayment(
  tabId: string,
  amount: number,
  tenderedAmount: number,
  discountInfo?: DiscountInfo,
  expectedVersion?: number,
  idempotencyKeyOverride?: string
): Promise<Result<CashPaymentResult, AppError>> {
  const idempotencyKey = idempotencyKeyOverride ?? generateIdempotencyKey('payment_cash');
  const result = await callProcessPayment({
    tabId,
    amount,
    method: 'cash',
    idempotencyKey,
    tenderedAmount,
    discountScope: discountInfo?.scope,
    discountType: discountInfo?.type,
    discountValue: discountInfo?.value,
    discountAmount: discountInfo?.amount,
    managerOverride: discountInfo?.managerOverride,
    managerPin: discountInfo?.managerPin,
    expectedVersion,
  });

  if (!result.ok) {
    return result;
  }

  const change = result.data.receiptData.changeAmount ?? Math.max(0, tenderedAmount - amount);
  return ok({
    paymentId: result.data.paymentId,
    changeAmount: Math.round(change * 100) / 100,
    receiptData: result.data.receiptData,
  });
}

/**
 * Shared body for any payment method that carries an optional free-text
 * reference and no tendered amount — card, and the delivery-platform tenders
 * (rappi/uber_eats) which behave identically to card at the payment layer.
 */
async function processReferencedPayment(
  method: Exclude<PaymentMethod, 'cash' | 'bank_transfer'>,
  tabId: string,
  amount: number,
  referenceNumber?: string,
  discountInfo?: DiscountInfo,
  expectedVersion?: number,
  idempotencyKeyOverride?: string
): Promise<Result<CardPaymentResult, AppError>> {
  const idempotencyKey = idempotencyKeyOverride ?? generateIdempotencyKey(`payment_${method}`);
  const trimmed = referenceNumber?.trim();
  const result = await callProcessPayment({
    tabId,
    amount,
    method,
    idempotencyKey,
    referenceNumber: trimmed && trimmed.length > 0 ? trimmed : undefined,
    discountScope: discountInfo?.scope,
    discountType: discountInfo?.type,
    discountValue: discountInfo?.value,
    discountAmount: discountInfo?.amount,
    managerOverride: discountInfo?.managerOverride,
    managerPin: discountInfo?.managerPin,
    expectedVersion,
  });

  if (!result.ok) {
    return result;
  }

  return ok({
    paymentId: result.data.paymentId,
    receiptData: result.data.receiptData,
  });
}

export async function processCardPayment(
  tabId: string,
  amount: number,
  referenceNumber?: string,
  discountInfo?: DiscountInfo,
  expectedVersion?: number,
  idempotencyKeyOverride?: string
): Promise<Result<CardPaymentResult, AppError>> {
  return processReferencedPayment(
    'card',
    tabId,
    amount,
    referenceNumber,
    discountInfo,
    expectedVersion,
    idempotencyKeyOverride
  );
}

export async function processPlatformPayment(
  tabId: string,
  amount: number,
  method: 'rappi' | 'uber_eats',
  referenceNumber?: string,
  discountInfo?: DiscountInfo,
  expectedVersion?: number,
  idempotencyKeyOverride?: string
): Promise<Result<PlatformPaymentResult, AppError>> {
  return processReferencedPayment(
    method,
    tabId,
    amount,
    referenceNumber,
    discountInfo,
    expectedVersion,
    idempotencyKeyOverride
  );
}

export type SplitPaymentLegInput = {
  method: Exclude<PaymentMethod, 'bank_transfer'>;
  amount: number;
  tenderedAmount?: number;
  referenceNumber?: string;
};

export type SplitPaymentResult = {
  paymentGroupId: string;
  paymentIds: string[];
  receipts: ProcessSplitPaymentSuccess['receipts'];
};

export async function processSplitPayment(
  tabId: string,
  legs: SplitPaymentLegInput[],
  expectedTotal: number,
  discountInfo?: DiscountInfo,
  idempotencyKeyOverride?: string
): Promise<Result<SplitPaymentResult, AppError>> {
  const idempotencyKey = idempotencyKeyOverride ?? generateIdempotencyKey('payment_split');
  const result = await callProcessSplitPayment({
    tabId,
    legs,
    expectedTotal,
    idempotencyKey,
    discountScope: discountInfo?.scope,
    discountType: discountInfo?.type,
    discountValue: discountInfo?.value,
    discountAmount: discountInfo?.amount,
    managerOverride: discountInfo?.managerOverride,
    managerPin: discountInfo?.managerPin,
  });

  if (!result.ok) {
    return result;
  }

  return ok({
    paymentGroupId: result.data.paymentGroupId,
    paymentIds: result.data.paymentIds,
    receipts: result.data.receipts,
  });
}

