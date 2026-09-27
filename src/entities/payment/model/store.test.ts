import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  selectPaymentByTabId,
  selectPaymentsByDateRange,
  selectPaymentsByMethod,
  selectPaymentsByStaffId,
  selectTotalRevenue,
  usePaymentStore,
} from './store';
import type { CreatePayment, Payment } from './types';

const tabA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tabB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const staff1 = '11111111-1111-4111-8111-111111111111';
const staff2 = '22222222-2222-4222-8222-222222222222';

function createPayment(partial: Partial<Payment> & Pick<Payment, 'id' | 'tabId'>): Payment {
  return {
    amount: 10,
    method: 'cash',
    squarePaymentId: null,
    squareReceiptUrl: null,
    processedBy: staff1,
    processedAt: new Date('2026-04-17T14:00:00.000Z'),
    status: 'completed',
    ...partial,
  };
}

describe('usePaymentStore', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('33333333-3333-4333-8333-333333333333');
    usePaymentStore.setState({
      payments: [],
      lastFetched: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recordPayment appends payment with generated id and processedAt', () => {
    const data: CreatePayment = {
      tabId: tabA,
      amount: 5,
      method: 'card',
      squarePaymentId: null,
      squareReceiptUrl: null,
      processedBy: staff1,
      status: 'completed',
    };
    usePaymentStore.getState().recordPayment(data);

    const list = usePaymentStore.getState().payments;
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('33333333-3333-4333-8333-333333333333');
    expect(list[0]?.processedAt).toBeInstanceOf(Date);
    expect(list[0]?.tabId).toBe(tabA);
  });

  it('setPayments replaces list and sets lastFetched', () => {
    const p = createPayment({
      id: '44444444-4444-4444-8444-444444444444',
      tabId: tabA,
    });
    usePaymentStore.getState().setPayments([p]);

    const state = usePaymentStore.getState();
    expect(state.payments).toEqual([p]);
    expect(state.lastFetched).toBeInstanceOf(Date);
  });

  it('setFromRealtime INSERT adds when id not duplicate', () => {
    usePaymentStore.getState().setFromRealtime({
      eventType: 'INSERT',
      new: createPayment({ id: '55555555-5555-4555-8555-555555555555', tabId: tabA }),
      old: {},
    });
    expect(usePaymentStore.getState().payments).toHaveLength(1);
  });

  it('setFromRealtime INSERT skips when id already exists', () => {
    const p = createPayment({ id: '66666666-6666-4666-8666-666666666666', tabId: tabA });
    usePaymentStore.setState({ payments: [p] });
    usePaymentStore.getState().setFromRealtime({
      eventType: 'INSERT',
      new: p,
      old: {},
    });
    expect(usePaymentStore.getState().payments).toHaveLength(1);
  });

  it('setFromRealtime UPDATE merges by id', () => {
    const p = createPayment({
      id: '77777777-7777-4777-8777-777777777777',
      tabId: tabA,
      amount: 10,
    });
    usePaymentStore.setState({ payments: [p] });
    usePaymentStore.getState().setFromRealtime({
      eventType: 'UPDATE',
      new: { id: '77777777-7777-4777-8777-777777777777', amount: 20 },
      old: {},
    });
    expect(usePaymentStore.getState().payments[0]?.amount).toBe(20);
  });

  it('setFromRealtime DELETE removes by old id', () => {
    const p = createPayment({ id: '88888888-8888-4888-8888-888888888888', tabId: tabA });
    usePaymentStore.setState({ payments: [p] });
    usePaymentStore.getState().setFromRealtime({
      eventType: 'DELETE',
      new: {},
      old: { id: '88888888-8888-4888-8888-888888888888' },
    });
    expect(usePaymentStore.getState().payments).toHaveLength(0);
  });

  it('setFromRealtime INSERT without id does not add', () => {
    usePaymentStore.setState({
      payments: [createPayment({ id: '99999999-9999-4999-8999-999999999999', tabId: tabA })],
    });
    usePaymentStore.getState().setFromRealtime({
      eventType: 'INSERT',
      new: {},
      old: {},
    });
    expect(usePaymentStore.getState().payments).toHaveLength(1);
  });

  it('setFromRealtime default branch leaves state unchanged', () => {
    usePaymentStore.setState({
      payments: [createPayment({ id: '99999999-9999-4999-8999-999999999999', tabId: tabA })],
    });
    usePaymentStore.getState().setFromRealtime({
      eventType: 'UNKNOWN',
      new: {},
      old: {},
    } as never);
    expect(usePaymentStore.getState().payments).toHaveLength(1);
  });
});

describe('payment selectors', () => {
  beforeEach(() => {
    usePaymentStore.setState({
      payments: [
        createPayment({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          tabId: tabA,
          method: 'cash',
          amount: 40,
          processedBy: staff1,
          processedAt: new Date('2026-04-17T10:00:00.000Z'),
        }),
        createPayment({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
          tabId: tabB,
          method: 'card',
          amount: 60,
          processedBy: staff2,
          processedAt: new Date('2026-04-17T16:00:00.000Z'),
        }),
      ],
      lastFetched: null,
    });
  });

  it('selectPaymentByTabId returns first match', () => {
    expect(selectPaymentByTabId(tabA)?.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
    expect(selectPaymentByTabId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toBeUndefined();
  });

  it('selectPaymentsByMethod filters', () => {
    expect(selectPaymentsByMethod('cash').map(p => p.id)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    ]);
    expect(selectPaymentsByMethod('rappi')).toHaveLength(0);
  });

  it('selectPaymentsByStaffId filters', () => {
    expect(selectPaymentsByStaffId(staff2).map(p => p.id)).toEqual([
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    ]);
  });

  it('selectPaymentsByDateRange is inclusive on boundaries', () => {
    const start = new Date('2026-04-17T09:00:00.000Z');
    const end = new Date('2026-04-17T11:00:00.000Z');
    const inRange = selectPaymentsByDateRange(start, end);
    expect(inRange.map(p => p.id)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1']);
  });

  it('selectTotalRevenue sums in range', () => {
    const start = new Date('2026-04-17T00:00:00.000Z');
    const end = new Date('2026-04-17T23:59:59.999Z');
    expect(selectTotalRevenue(start, end)).toBe(100);
  });
});
