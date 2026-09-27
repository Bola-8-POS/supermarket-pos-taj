import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@shared/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import { findStaffPinHolder, verifyStaffPin } from './pinVerification';

describe('verifyStaffPin', () => {
  beforeEach(() => rpc.mockReset());

  it('returns the matches on success', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    rpc.mockResolvedValue({ data: { ok: true, matches: [{ id, name: 'A', role: 'manager' }] }, error: null });
    const res = await verifyStaffPin('000000');
    expect(rpc).toHaveBeenCalledWith('verify_staff_pin', {
      p_pin: '000000',
      p_staff_id: null,
      p_required_action: null,
    });
    expect(res).toEqual({ ok: true, matches: [{ id, name: 'A', role: 'manager' }] });
  });

  it('passes the staff id through', async () => {
    rpc.mockResolvedValue({ data: { ok: false, code: 'INVALID_PIN', retry_after: 0 }, error: null });
    await verifyStaffPin('000000', 'abc');
    expect(rpc).toHaveBeenCalledWith('verify_staff_pin', {
      p_pin: '000000',
      p_staff_id: 'abc',
      p_required_action: null,
    });
  });

  it('passes the required action through', async () => {
    rpc.mockResolvedValue({ data: { ok: false, code: 'INVALID_PIN', retry_after: 0 }, error: null });
    await verifyStaffPin('000000', undefined, 'process_refund');
    expect(rpc).toHaveBeenCalledWith('verify_staff_pin', {
      p_pin: '000000',
      p_staff_id: null,
      p_required_action: 'process_refund',
    });
  });

  it('maps a lock', async () => {
    rpc.mockResolvedValue({ data: { ok: false, code: 'LOCKED', retry_after: 42 }, error: null });
    expect(await verifyStaffPin('000000')).toEqual({ ok: false, code: 'LOCKED', retryAfter: 42 });
  });

  it('reports UNAVAILABLE on a transport error, a thrown error and an unexpected shape', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'fetch failed' } });
    expect(await verifyStaffPin('000000')).toEqual({ ok: false, code: 'UNAVAILABLE', retryAfter: 0 });
    rpc.mockRejectedValueOnce(new Error('offline'));
    expect(await verifyStaffPin('000000')).toEqual({ ok: false, code: 'UNAVAILABLE', retryAfter: 0 });
    rpc.mockResolvedValueOnce({ data: { nope: true }, error: null });
    expect(await verifyStaffPin('000000')).toEqual({ ok: false, code: 'UNAVAILABLE', retryAfter: 0 });
  });
});

describe('findStaffPinHolder', () => {
  beforeEach(() => rpc.mockReset());

  it('returns the name, or null when free or on error', async () => {
    rpc.mockResolvedValueOnce({ data: 'Jamie', error: null });
    expect(await findStaffPinHolder('000000', 'x')).toBe('Jamie');
    expect(rpc).toHaveBeenCalledWith('staff_pin_holder', { p_pin: '000000', p_exclude_staff_id: 'x' });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await findStaffPinHolder('000000')).toBeNull();
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    expect(await findStaffPinHolder('000000')).toBeNull();
  });
});
