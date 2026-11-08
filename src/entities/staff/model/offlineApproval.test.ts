import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  approveOffline,
  availableOfflineGrants,
  clearApprovalVerifier,
  markGrantUsesReported,
  pendingGrantUses,
  rememberApprovalVerifier,
  revokeIfInactive,
  storeOfflineGrants,
  type OfflineGrant,
} from './offlineApproval';

const STAFF = '11111111-1111-4111-8111-111111111111';
const MANAGER = '22222222-2222-4222-8222-222222222222';
const HOUR = 60 * 60 * 1000;

function grant(overrides: Partial<OfflineGrant> = {}): OfflineGrant {
  return {
    id: crypto.randomUUID(),
    action: 'process_refund',
    grantedBy: MANAGER,
    requestedFor: STAFF,
    expiresAt: Date.now() + 8 * HOUR,
    terminalId: 'POS-1',
    ...overrides,
  };
}

describe('offline approval', () => {
  beforeEach(() => {
    localStorage.clear();
    clearApprovalVerifier();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses when no verifier has been seeded', async () => {
    storeOfflineGrants([grant()]);
    const res = await approveOffline('process_refund', '123456');
    expect(res).toMatchObject({ ok: false, reason: 'no_verifier' });
  });

  it('redeems a grant with the signed-in PIN and returns the approval', async () => {
    const g = grant();
    storeOfflineGrants([g]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    const res = await approveOffline('process_refund', '123456');
    expect(res.ok).toBe(true);
    expect(res.ok && res.approval).toMatchObject({
      grantId: g.id,
      action: 'process_refund',
      grantedBy: MANAGER,
      usedBy: STAFF,
      terminalId: 'POS-1',
    });
  });

  it('rejects a wrong PIN and keeps the grant', async () => {
    storeOfflineGrants([grant()]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    const res = await approveOffline('process_refund', '000000');
    expect(res).toMatchObject({ ok: false, reason: 'wrong_pin' });
    expect(availableOfflineGrants('process_refund')).toHaveLength(1);
  });

  it('refuses without a grant for the action, before the PIN costs an attempt', async () => {
    storeOfflineGrants([grant({ action: 'reopen_tab' })]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    for (let i = 0; i < 6; i += 1) {
      expect(await approveOffline('process_refund', '000000')).toMatchObject({ ok: false, reason: 'no_grant' });
    }
    expect(await approveOffline('reopen_tab', '123456')).toMatchObject({ ok: true });
  });

  it("does not offer or redeem another cashier's grants", async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    storeOfflineGrants([grant({ requestedFor: OTHER })]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    expect(availableOfflineGrants('process_refund')).toHaveLength(0);
    expect(await approveOffline('process_refund', '123456')).toMatchObject({ ok: false, reason: 'no_grant' });
    expect(pendingGrantUses()).toHaveLength(0);
  });

  it('uses each grant once', async () => {
    storeOfflineGrants([grant()]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    expect((await approveOffline('process_refund', '123456')).ok).toBe(true);
    expect(await approveOffline('process_refund', '123456')).toMatchObject({ ok: false, reason: 'no_grant' });
  });

  it('ignores expired grants and grants issued to another terminal', async () => {
    storeOfflineGrants([grant({ expiresAt: Date.now() - 1 }), grant({ terminalId: 'POS-9' })]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    expect(await approveOffline('process_refund', '123456')).toMatchObject({ ok: false, reason: 'no_grant' });
  });

  it('locks out after the free attempts and survives a reload', async () => {
    storeOfflineGrants([grant()]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    for (let i = 0; i < 5; i += 1) {
      await approveOffline('process_refund', '000000');
    }
    const res = await approveOffline('process_refund', '123456');
    expect(res).toMatchObject({ ok: false, reason: 'locked_out' });
    expect(!res.ok && res.retryAfterMs).toBeGreaterThan(0);

    // A reload must not reset the counter: re-import against the same localStorage.
    vi.resetModules();
    const reloaded = await import('./offlineApproval');
    const after = await reloaded.approveOffline('process_refund', '123456');
    expect(after).toMatchObject({ ok: false, reason: 'locked_out' });
  });

  it('expires the verifier after 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    storeOfflineGrants([grant({ expiresAt: Date.now() + 48 * HOUR })]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    vi.setSystemTime(Date.now() + 24 * HOUR + 1);
    const res = await approveOffline('process_refund', '123456');
    expect(res).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('never writes the PIN itself to storage', async () => {
    storeOfflineGrants([grant()]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    await approveOffline('process_refund', '123456');
    const dump = Object.keys(localStorage).map(k => `${k}=${localStorage.getItem(k) ?? ''}`).join('\n');
    expect(dump).toContain('pos.offline_approval');
    expect(dump).not.toContain('123456');
  });

  it('logs each offline use until it is reported', async () => {
    const g = grant();
    storeOfflineGrants([g]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    await approveOffline('process_refund', '123456');
    expect(pendingGrantUses()).toEqual([expect.objectContaining({ grantId: g.id, usedBy: STAFF })]);
    markGrantUsesReported([g.id]);
    expect(pendingGrantUses()).toEqual([]);
  });

  it('clears the verifier when the signed-in staff member is no longer active', async () => {
    storeOfflineGrants([grant()]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    revokeIfInactive([{ id: STAFF, isActive: false }, { id: MANAGER, isActive: true }]);
    const res = await approveOffline('process_refund', '123456');
    expect(res).toMatchObject({ ok: false, reason: 'no_verifier' });
  });

  it('drops grants whose issuer is no longer active', async () => {
    storeOfflineGrants([grant()]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    revokeIfInactive([{ id: STAFF, isActive: true }]);
    expect(availableOfflineGrants('process_refund')).toEqual([]);
  });

  describe('admin verifier (owner decision: never persisted)', () => {
    it('keeps an admin verifier in memory only, never in storage', async () => {
      storeOfflineGrants([grant()]);
      await rememberApprovalVerifier(STAFF, '123456', 'admin');
      expect(localStorage.getItem('pos.offline_approval')).toBeNull();
      expect(await approveOffline('process_refund', '123456')).toMatchObject({ ok: true });
    });

    it('loses an admin verifier on reload, so an admin must sign in online again', async () => {
      storeOfflineGrants([grant()]);
      await rememberApprovalVerifier(STAFF, '123456', 'admin');
      vi.resetModules();
      const reloaded = await import('./offlineApproval');
      expect(await reloaded.approveOffline('process_refund', '123456')).toMatchObject({
        ok: false,
        reason: 'no_verifier',
      });
    });

    it('removes a stored verifier when an admin signs in after someone else', async () => {
      await rememberApprovalVerifier(MANAGER, '654321', 'manager');
      expect(localStorage.getItem('pos.offline_approval')).not.toBeNull();
      await rememberApprovalVerifier(STAFF, '123456', 'admin');
      expect(localStorage.getItem('pos.offline_approval')).toBeNull();
    });

    it('drops an in-memory admin verifier when someone else signs in', async () => {
      storeOfflineGrants([grant({ requestedFor: MANAGER })]);
      await rememberApprovalVerifier(STAFF, '123456', 'admin');
      await rememberApprovalVerifier(MANAGER, '654321', 'manager');
      const res = await approveOffline('process_refund', '654321');
      expect(res.ok && res.approval.usedBy).toBe(MANAGER);
    });

    it('clears an in-memory admin verifier on logout', async () => {
      storeOfflineGrants([grant()]);
      await rememberApprovalVerifier(STAFF, '123456', 'admin');
      clearApprovalVerifier();
      expect(await approveOffline('process_refund', '123456')).toMatchObject({ ok: false, reason: 'no_verifier' });
    });
  });

  it('ignores an empty directory rather than revoking everything', async () => {
    storeOfflineGrants([grant()]);
    await rememberApprovalVerifier(STAFF, '123456', 'cashier');
    revokeIfInactive([]);
    expect((await approveOffline('process_refund', '123456')).ok).toBe(true);
  });
});
