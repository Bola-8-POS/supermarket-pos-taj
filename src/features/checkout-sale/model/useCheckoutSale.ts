import { useRef } from 'react';
import { useCajaStore } from '@entities/caja';
import { useStaffStore } from '@entities/staff';
import { calcWeightedLineTotal, useCartStore } from '@entities/tab/model/cartStore';
import { isOnline } from '@shared/lib/connectivity';
import type { CartItem, PaymentMethod, Tab } from '@shared/lib/domain';
import { generateIdempotencyKey } from '@shared/lib/domain-helpers';
import { callProcessDirectSale } from '@shared/lib/edge-function-contracts';
import i18n from '@shared/lib/i18n';
import type { DiscountInfo, SplitPaymentLegInput } from '@shared/lib/payment-processor';
import { err, networkOfflineError, ok } from '@shared/lib/result';

const placeholderId = () => crypto.randomUUID();

function cartItemsToSyntheticTab(
  items: CartItem[],
  staffId: string,
  shiftId: string,
  tabId: string
): Tab {
  const orderId = placeholderId();
  return {
    id: tabId,
    customerName: i18n.t('featOrders:checkoutSale.defaultCustomerName'),
    staffId,
    shiftId,
    openedAt: new Date(),
    closedAt: null,
    status: 'open',
    notes: null,
    orders: [],
    items: items.map(item => ({
      id: item.tempId,
      orderId,
      productId: item.product.id,
      quantity: item.quantity,
      unitPrice: item.weightGrams != null ? item.lineTotal : item.unitPrice,
      weightGrams: item.weightGrams ?? null,
      modifierIds: item.selectedModifiers.map(modifier => modifier.id),
      modifierPriceDelta: item.selectedModifiers.reduce(
        (sum, modifier) => sum + modifier.priceDelta,
        0
      ),
      notes: item.notes || null,
      product: item.product,
      modifiers: item.selectedModifiers,
      lineTotal: item.lineTotal,
    })),
    subtotal: items.reduce((sum, item) => sum + item.lineTotal, 0),
    rappiOrderId: undefined,
    cajaSessionId: null,
    version: 0,
  };
}

function cartItemsToRpcItems(items: CartItem[]) {
  return items.map(item => ({
    productId: item.product.id,
    quantity: item.quantity,
    // process_direct_sale_atomic's PRICE_MISMATCH check validates unit_price
    // against the product's own undiscounted catalog price (products.base_price,
    // weight-adjusted for soldByWeight items) — never the cart's live-discounted
    // display price (PROMO-03 is display-only; the RPC independently recomputes
    // and applies any qualifying promotion server-side, Plan 27-01). Submitting
    // item.unitPrice/lineTotal here once they can hold a discounted value would
    // make every promoted-item checkout fail PRICE_MISMATCH.
    unitPrice:
      item.weightGrams != null
        ? calcWeightedLineTotal(item.product.basePrice, item.weightGrams)
        : item.product.basePrice,
    modifierIds: item.selectedModifiers.map(modifier => modifier.id),
    modifierPriceDelta: item.selectedModifiers.reduce(
      (sum, modifier) => sum + modifier.priceDelta,
      0
    ),
    notes: item.notes || null,
    weightGrams: item.weightGrams ?? undefined,
  }));
}

export function useCheckoutSale() {
  const items = useCartStore(state => state.items);
  const staff = useStaffStore(state => state.currentStaff);
  const shift = useStaffStore(state => state.currentShift);
  const caja = useCajaStore(state => state.currentCaja);
  const isCajaOpen = useCajaStore(state => state.isCajaOpen);
  const tabId = useRef(placeholderId()).current;
  const idempotencyKeyRef = useRef<string | null>(null);
  const syntheticTab = cartItemsToSyntheticTab(
    items,
    staff?.id ?? tabId,
    shift?.id ?? tabId,
    tabId
  );

  const submit = async (payment: {
    method?: PaymentMethod;
    amount?: number;
    tenderedAmount?: number;
    referenceNumber?: string;
    legs?: {
      method: Exclude<PaymentMethod, 'bank_transfer'>;
      amount: number;
      tenderedAmount?: number;
      referenceNumber?: string;
    }[];
    expectedTotal?: number;
    discountInfo?: DiscountInfo | undefined;
    idempotencyKeyOverride?: string;
    customerName?: string;
    customerPhone?: string;
  }) => {
    if (!isOnline()) {
      return err(networkOfflineError());
    }
    if (!staff || !shift || !isCajaOpen || !caja) {
      return err({ code: 'CAJA_CLOSED', message: i18n.t('entities:tab.cajaNotOpen') });
    }
    idempotencyKeyRef.current ??=
      // eslint-disable-next-line i18next/no-literal-string -- idempotency-key prefix, not UI copy
      payment.idempotencyKeyOverride ?? generateIdempotencyKey('direct_sale');
    return callProcessDirectSale({
      items: cartItemsToRpcItems(items),
      shiftId: shift.id,
      cajaSessionId: caja.id,
      idempotencyKey: idempotencyKeyRef.current,
      ...(payment.method ? { method: payment.method } : {}),
      ...(payment.amount !== undefined ? { amount: payment.amount } : {}),
      ...(payment.tenderedAmount !== undefined ? { tenderedAmount: payment.tenderedAmount } : {}),
      ...(payment.referenceNumber ? { referenceNumber: payment.referenceNumber } : {}),
      ...(payment.legs ? { legs: payment.legs } : {}),
      ...(payment.expectedTotal !== undefined ? { expectedTotal: payment.expectedTotal } : {}),
      ...(payment.discountInfo
        ? {
            discountScope: payment.discountInfo.scope,
            discountType: payment.discountInfo.type,
            discountValue: payment.discountInfo.value,
            discountAmount: payment.discountInfo.amount,
            managerOverride: payment.discountInfo.managerOverride,
            managerPin: payment.discountInfo.managerPin,
          }
        : {}),
      ...(payment.customerName ? { customerName: payment.customerName } : {}),
      ...(payment.customerPhone ? { customerPhone: payment.customerPhone } : {}),
    });
  };

  return {
    syntheticTab,
    processors: {
      processCashPayment: async (
        _tabId: string,
        amount: number,
        tenderedAmount: number,
        discountInfo?: DiscountInfo,
        _expectedVersion?: number,
        idempotencyKeyOverride?: string
      ) => {
        const result = await submit({
          method: 'cash',
          amount,
          tenderedAmount,
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
        });
        if (!result.ok || !result.data.paymentId || !result.data.receiptData)
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        return ok({
          paymentId: result.data.paymentId,
          changeAmount: result.data.receiptData.changeAmount ?? 0,
          receiptData: result.data.receiptData,
        });
      },
      processCardPayment: async (
        _tabId: string,
        amount: number,
        referenceNumber?: string,
        discountInfo?: DiscountInfo,
        _expectedVersion?: number,
        idempotencyKeyOverride?: string
      ) => {
        const result = await submit({
          method: 'card',
          amount,
          ...(referenceNumber ? { referenceNumber } : {}),
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
        });
        if (!result.ok || !result.data.paymentId || !result.data.receiptData)
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        return ok({ paymentId: result.data.paymentId, receiptData: result.data.receiptData });
      },
      processBankTransferPayment: async (
        _tabId: string,
        amount: number,
        customerName: string,
        customerPhone: string,
        discountInfo?: DiscountInfo,
        _expectedVersion?: number,
        idempotencyKeyOverride?: string
      ) => {
        const result = await submit({
          method: 'bank_transfer',
          amount,
          customerName,
          customerPhone,
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
        });
        if (!result.ok || !result.data.paymentId || !result.data.receiptData)
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        return ok({
          paymentId: result.data.paymentId,
          referenceCode: result.data.receiptData.terminalReference ?? '',
          receiptData: result.data.receiptData,
        });
      },
      processPlatformPayment: async (
        _tabId: string,
        amount: number,
        method: 'rappi' | 'uber_eats',
        referenceNumber?: string,
        discountInfo?: DiscountInfo,
        _expectedVersion?: number,
        idempotencyKeyOverride?: string
      ) => {
        const result = await submit({
          method,
          amount,
          ...(referenceNumber ? { referenceNumber } : {}),
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
        });
        if (!result.ok || !result.data.paymentId || !result.data.receiptData)
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        return ok({ paymentId: result.data.paymentId, receiptData: result.data.receiptData });
      },
      processSplitPayment: async (
        _tabId: string,
        legs: SplitPaymentLegInput[],
        expectedTotal: number,
        discountInfo?: DiscountInfo,
        idempotencyKeyOverride?: string
      ) => {
        const result = await submit({
          legs,
          expectedTotal,
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
        });
        if (
          !result.ok ||
          !result.data.paymentGroupId ||
          !result.data.paymentIds ||
          !result.data.receiptData
        ) {
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        }
        // process-direct-sale now returns one sale-level receiptData for a
        // split direct sale (basket composed once, every leg in
        // receiptData.tenders) rather than one receipt per leg. Wrap it as
        // a single-element array so PaymentForm's PaymentProcessors
        // contract — shared with the untouched generic tab split-payment
        // path, which still returns one receipt per leg (D-09) — stays
        // structurally unchanged.
        return ok({
          paymentGroupId: result.data.paymentGroupId,
          paymentIds: result.data.paymentIds,
          receipts: [result.data.receiptData],
        });
      },
    },
    resetIdempotencyKey: () => {
      idempotencyKeyRef.current = null;
    },
  };
}
