import { summarize } from './queries';

const p = (over: Partial<Parameters<typeof summarize>[0][number]>) => ({
  amount: 100,
  is_refund: false,
  tab_id: 't1',
  status: 'completed',
  ...over,
});

describe('summarize', () => {
  it('sums revenue, counts distinct tickets, separates refunds', () => {
    const s = summarize([
      p({ amount: 150, tab_id: 'a' }),
      p({ amount: 50, tab_id: 'a' }), // split payment, same ticket
      p({ amount: 200, tab_id: 'b' }),
      p({ amount: -30, tab_id: 'b', is_refund: true }),
    ]);
    expect(s.revenue).toBe(400);
    expect(s.tickets).toBe(2);
    expect(s.avgTicket).toBe(200);
    expect(s.refunds).toBe(30);
    expect(s.refundCount).toBe(1);
  });

  it('counts only completed payments (not pending/disputed transfers or reopened voids)', () => {
    const s = summarize([
      p({ status: 'pending' }),
      p({ status: 'disputed', tab_id: 'x' }),
      p({ status: 'reopened_void', tab_id: 'z' }),
      p({ tab_id: 'y' }),
    ]);
    expect(s.revenue).toBe(100);
    expect(s.tickets).toBe(1);
  });

  it('handles empty input', () => {
    expect(summarize([])).toEqual({ revenue: 0, tickets: 0, avgTicket: 0, refunds: 0, refundCount: 0 });
  });
});
