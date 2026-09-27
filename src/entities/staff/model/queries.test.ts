import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { StaffSchema } from '@shared/lib/domain';
import i18n, { getCurrentLocale } from '@shared/lib/i18n';
import { supabase } from '@shared/lib/supabase';
import type { Tables } from '@shared/lib/supabase.types';

import { mapStaffRow, useMutationSetOwnLocale, useMutationUpdateStaffLocale } from './queries';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  Wrapper.displayName = 'TestQueryClientProvider';
  return Wrapper;
}

type Chainable = Record<string, ReturnType<typeof vi.fn>>;

function makeProfileRow(overrides: Partial<Tables<'profiles'>> = {}): Tables<'profiles'> {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Alex Martinez',
    email: 'alex@barpos.dev',
    role: 'cashier',
    pin: '123456',
    is_active: true,
    must_change_pin: false,
    locale: 'es-MX',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

describe('StaffSchema.locale', () => {
  it('defaults to es-MX when the row omits locale', () => {
    const parsed = StaffSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Alex Martinez',
      email: 'alex@barpos.dev',
      role: 'cashier',
      pin: '123456',
      isActive: true,
      mustChangePin: false,
    });

    expect(parsed.locale).toBe('es-MX');
  });

  it('parses en-US locale unchanged', () => {
    const parsed = StaffSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Alex Martinez',
      email: 'alex@barpos.dev',
      role: 'cashier',
      pin: '123456',
      isActive: true,
      mustChangePin: false,
      locale: 'en-US',
    });

    expect(parsed.locale).toBe('en-US');
  });

  it('rejects an unsupported locale', () => {
    expect(() =>
      StaffSchema.parse({
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Alex Martinez',
        email: 'alex@barpos.dev',
        role: 'cashier',
        pin: '123456',
        isActive: true,
        mustChangePin: false,
        locale: 'fr-FR',
      })
    ).toThrow();
  });
});

describe('mapStaffRow locale', () => {
  it('carries row.locale through into the mapped Staff object', () => {
    const result = mapStaffRow(makeProfileRow({ locale: 'en-US' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.locale).toBe('en-US');
  });
});

describe('getCurrentLocale', () => {
  it('reflects the current i18n language after changeLanguage', async () => {
    await i18n.changeLanguage('es-MX');
    expect(getCurrentLocale()).toBe('es-MX');

    await i18n.changeLanguage('en-US');
    expect(getCurrentLocale()).toBe('en-US');
  });
});

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedRpc = vi.mocked(supabase.rpc);
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedFrom = vi.mocked(supabase.from);

describe('useMutationSetOwnLocale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls set_own_locale RPC with p_locale and no staffId param', async () => {
    mockedRpc.mockResolvedValue({ data: { ok: true }, error: null } as never);

    const { result } = renderHook(() => useMutationSetOwnLocale(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ locale: 'en-US' });

    await waitFor(() => {
      expect(mockedRpc).toHaveBeenCalledTimes(1);
    });

    const [rpcName, rpcArgs] = mockedRpc.mock.calls[0]!;
    expect(rpcName).toBe('set_own_locale');
    expect(rpcArgs).toMatchObject({ p_locale: 'en-US' });
    expect(rpcArgs).not.toHaveProperty('staffId');
    expect(rpcArgs).not.toHaveProperty('p_staff_id');
  });
});

describe('useMutationUpdateStaffLocale', () => {
  const STAFF_ID = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls profiles.update({ locale }).eq(id, staffId) for the target staff', async () => {
    const chain: Chainable = {
      update: vi.fn(),
      eq: vi.fn(),
      select: vi.fn(),
      single: vi.fn().mockResolvedValue({ data: makeProfileRow({ id: STAFF_ID }), error: null }),
    };
    chain.update!.mockReturnValue(chain);
    chain.eq!.mockReturnValue(chain);
    chain.select!.mockReturnValue(chain);
    mockedFrom.mockReturnValue(chain as never);
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    const { result } = renderHook(() => useMutationUpdateStaffLocale(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({ staffId: STAFF_ID, locale: 'en-US' });

    expect(mockedFrom).toHaveBeenCalledWith('profiles');
    expect(chain.update).toHaveBeenCalledWith({ locale: 'en-US' });
    expect(chain.eq).toHaveBeenCalledWith('id', STAFF_ID);
  });
});
