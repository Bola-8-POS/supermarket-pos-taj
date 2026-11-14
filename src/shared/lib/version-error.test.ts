/* eslint-disable import/order, @typescript-eslint/unbound-method -- vi.mock factories must precede module imports; mock-spy access for assertion */
/**
 * Tests for handleVersionError — Phase 15-03 Task 1.
 */
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('./logger-instance', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { toast } from 'sonner';
import { logger } from './logger-instance';
import { staleVersionError, notFoundVersionedError, type AppError } from './result';
import { handleVersionError, type VersionErrorContext } from './version-error';

const toastMock = toast as unknown as {
  error: ReturnType<typeof vi.fn>;
  success: ReturnType<typeof vi.fn>;
};
const loggerMock = logger as unknown as { warn: ReturnType<typeof vi.fn> };

function makeCtx(opts: {
  rpcResult?: { error: { message: string } | null };
  rpcThrows?: boolean;
}): VersionErrorContext {
  const rpcSpy = vi.fn(() => {
    if (opts.rpcThrows) {
      throw new Error('rpc-throw');
    }
    return Promise.resolve(opts.rpcResult ?? { error: null });
  });
  const supabase = { rpc: rpcSpy };
  const queryClient = new QueryClient();
  vi.spyOn(queryClient, 'invalidateQueries');
  return {
    queryClient,
    queryKey: ['tabs', 'detail', 'tab-1'],
    entity: 'tabs',
    entityId: 'tab-1',
    expectedVersion: 3,
    supabase: supabase as any,
    terminalId: 'POS-1',
  };
}

describe('handleVersionError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Test 1: invalidates queries on STALE_VERSION', () => {
    const ctx = makeCtx({});
    const result = handleVersionError(staleVersionError(), ctx);
    expect(result).toBe(true);
    expect(ctx.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ctx.queryKey });
  });

  it('Test 2: shows exact stale-version toast copy', () => {
    const ctx = makeCtx({});
    handleVersionError(staleVersionError(), ctx);
    expect(toastMock.error).toHaveBeenCalledWith('Updated by another terminal — please retry');
  });

  it('Test 3: calls record_audit (best-effort, fire-and-forget)', () => {
    const ctx = makeCtx({});
    handleVersionError(staleVersionError(), ctx);
    const rpcSpy = (ctx.supabase as any).rpc as ReturnType<typeof vi.fn>;
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith(
      'record_audit',
      expect.objectContaining({
        p_action: 'conflict.stale_version',
        p_entity_type: 'tabs',
        p_entity_id: 'tab-1',
      })
    );
  });

  it('Test 4: shows not-found toast on NOT_FOUND_VERSIONED', () => {
    const ctx = makeCtx({});
    const result = handleVersionError(notFoundVersionedError(), ctx);
    expect(result).toBe(true);
    expect(toastMock.error).toHaveBeenCalledWith('Record was deleted by another terminal.');
  });

  it('Test 5: returns false on unrelated error code', () => {
    const ctx = makeCtx({});
    const other: AppError = { code: 'NETWORK_OFFLINE', message: 'offline' };
    const result = handleVersionError(other, ctx);
    expect(result).toBe(false);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('Test 6: audit RPC failure is swallowed and logged via logger.warn', async () => {
    const ctx = makeCtx({ rpcResult: { error: { message: 'audit failed' } } });
    expect(() => handleVersionError(staleVersionError(), ctx)).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('Test 6b: audit RPC throw is swallowed and logged', () => {
    const ctx = makeCtx({ rpcThrows: true });
    expect(() => handleVersionError(staleVersionError(), ctx)).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});
