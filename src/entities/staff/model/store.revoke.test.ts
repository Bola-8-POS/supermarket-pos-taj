import { beforeEach, describe, expect, it } from 'vitest';

import type { Staff } from '@shared/lib/domain';

import { checkOfflineUnlock, rememberOfflineUnlock } from './offlineUnlock';
import { useStaffStore } from './store';

const SIGNED_IN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function staff(id: string): Staff {
  return { id, name: 'Someone', role: 'cashier', isActive: true, mustChangePin: false, locale: 'es-MX' } as Staff;
}

describe('staff directory refresh', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('revokes the offline verifier when the signed-in staff member drops out of the directory', async () => {
    await rememberOfflineUnlock(SIGNED_IN, '123456', 'cashier');
    useStaffStore.getState().setStaffList([staff(OTHER)]);
    expect(await checkOfflineUnlock(SIGNED_IN, '123456')).toEqual({ ok: false, retryAfter: 0 });
  });

  it('keeps it while the signed-in staff member is still listed', async () => {
    await rememberOfflineUnlock(SIGNED_IN, '123456', 'cashier');
    useStaffStore.getState().setStaffList([staff(SIGNED_IN), staff(OTHER)]);
    expect(await checkOfflineUnlock(SIGNED_IN, '123456')).toEqual({ ok: true });
  });
});
