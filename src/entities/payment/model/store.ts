import { create } from 'zustand';
import type { Payment, CreatePayment } from './types';

/**
 * Payment Store State
 * Manages payment records for closed tabs
 */
interface PaymentState {
  payments: Payment[];
  lastFetched: Date | null;
}

/**
 * Payment Store Actions
 */
interface PaymentActions {
  /**
   * Records a new payment for a tab
   * @param data - Payment creation data
   */
  recordPayment: (data: CreatePayment) => void;

  /**
   * Sets all payments (used for initial fetch)
   * @param payments - Array of payments
   */
  setPayments: (payments: Payment[]) => void;

  /**
   * Updates payment data from Supabase Realtime subscription
   * @param payload - Realtime payload with eventType and record
   */
  setFromRealtime: (payload: {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: Partial<Payment>;
    old: Partial<Payment>;
  }) => void;
}

type PaymentStore = PaymentState & PaymentActions;

/**
 * Zustand store for Payment entity
 * No persistence needed - payments are fetched fresh on app load
 */
export const usePaymentStore = create<PaymentStore>(set => ({
  // Initial state
  payments: [],
  lastFetched: null,

  // Actions
  recordPayment: data => {
    const newPayment: Payment = {
      id: crypto.randomUUID(),
      ...data,
      processedAt: new Date(),
    };

    set(state => ({
      payments: [...state.payments, newPayment],
    }));
  },

  setPayments: payments => {
    set({ payments, lastFetched: new Date() });
  },

  setFromRealtime: payload => {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    set(state => {
      switch (eventType) {
        case 'INSERT':
          if (newRecord.id && !state.payments.find(p => p.id === newRecord.id)) {
            return {
              payments: [...state.payments, newRecord as Payment],
            };
          }
          return state;

        case 'UPDATE':
          return {
            payments: state.payments.map(payment =>
              payment.id === newRecord.id ? { ...payment, ...newRecord } : payment
            ),
          };

        case 'DELETE':
          return {
            payments: state.payments.filter(payment => payment.id !== oldRecord.id),
          };

        default:
          return state;
      }
    });
  },
}));

/**
 * Selector: Get payment by tab ID
 * @param tabId - Tab ID
 */
export const selectPaymentByTabId = (tabId: string) => {
  const payments = usePaymentStore.getState().payments;
  return payments.find(payment => payment.tabId === tabId);
};

/**
 * Selector: Get all payments by method
 * @param method - Payment method ('cash', 'card', 'bank_transfer', 'rappi', 'uber_eats')
 */
export const selectPaymentsByMethod = (method: Payment['method']) => {
  const payments = usePaymentStore.getState().payments;
  return payments.filter(payment => payment.method === method);
};

/**
 * Selector: Get payments processed by a specific staff member
 * @param staffId - Staff ID
 */
export const selectPaymentsByStaffId = (staffId: string) => {
  const payments = usePaymentStore.getState().payments;
  return payments.filter(payment => payment.processedBy === staffId);
};

/**
 * Selector: Get payments within a date range
 * @param startDate - Start date
 * @param endDate - End date
 */
export const selectPaymentsByDateRange = (startDate: Date, endDate: Date) => {
  const payments = usePaymentStore.getState().payments;
  return payments.filter(
    payment => payment.processedAt >= startDate && payment.processedAt <= endDate
  );
};

/**
 * Selector: Calculate total revenue for a date range
 * @param startDate - Start date
 * @param endDate - End date
 */
export const selectTotalRevenue = (startDate: Date, endDate: Date) => {
  const payments = selectPaymentsByDateRange(startDate, endDate);
  return payments.reduce((total, payment) => total + payment.amount, 0);
};
