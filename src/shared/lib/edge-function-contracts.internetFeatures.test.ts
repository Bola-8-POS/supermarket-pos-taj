import { FunctionsHttpError } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const fetchMock = vi.fn();
vi.mock('./supabase', () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invokeMock(...args) } },
  getCachedAccessToken: () => 'test-access-token',
  licenseGuardedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import {
  callAgentProxy,
  callSendReceiptEmail,
  callSendSettingsTestEmail,
  internetFeatureError,
  mapAgentProxyErrorBody,
} from './edge-function-contracts';

function httpError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): FunctionsHttpError {
  return new FunctionsHttpError(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
  );
}

// Gateway envelopes: the till-to-server link, never "needs internet".
const gateway503s = [
  ['UPSTREAM_UNAVAILABLE', '5'],
  ['STORE_UPDATING', '30'],
] as const;

const agentRequest = {
  model: 'm',
  max_tokens: 1,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('internetFeatureError', () => {
  it('CONFIG is "not configured"', () => {
    expect(internetFeatureError('email', 'CONFIG')?.code).toBe('FEATURE_NOT_CONFIGURED');
    expect(internetFeatureError('ai', 'CONFIG')?.code).toBe('FEATURE_NOT_CONFIGURED');
  });
  it.each(['RESEND_ERROR', 'ANTHROPIC_ERROR', undefined])(
    '%s is "needs internet"',
    code => {
      expect(internetFeatureError('email', code)?.code).toBe('FEATURE_NEEDS_INTERNET');
    }
  );
  it.each(['RATE_LIMITED', 'FORBIDDEN', 'VALIDATION_ERROR', 'UNAUTHORIZED'])(
    '%s is not ours',
    code => {
      expect(internetFeatureError('email', code)).toBeNull();
    }
  );
  it.each(['ai', 'email'] as const)(
    'a nested INTERNAL (the own-database failure) is not "needs internet" for %s',
    feature => {
      expect(internetFeatureError(feature, 'INTERNAL')).toBeNull();
    }
  );
  it('a gateway 503 UPSTREAM_UNAVAILABLE / STORE_UPDATING is not "needs internet"', () => {
    expect(internetFeatureError('ai', 'UPSTREAM_UNAVAILABLE')).toBeNull();
    expect(internetFeatureError('ai', 'STORE_UPDATING')).toBeNull();
  });
  it('the two messages differ and are not the generic server error', () => {
    const a = internetFeatureError('ai', 'CONFIG')?.message;
    const b = internetFeatureError('ai', 'ANTHROPIC_ERROR')?.message;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe('mapAgentProxyErrorBody', () => {
  it('maps CONFIG and ANTHROPIC_ERROR', () => {
    expect(mapAgentProxyErrorBody({ code: 'CONFIG', message: 'x' }, 500).code).toBe(
      'FEATURE_NOT_CONFIGURED'
    );
    expect(mapAgentProxyErrorBody({ code: 'ANTHROPIC_ERROR', message: 'x' }, 502).code).toBe(
      'FEATURE_NEEDS_INTERNET'
    );
  });
  it('a bare 500 with no envelope needs internet; RATE_LIMITED is unchanged', () => {
    expect(mapAgentProxyErrorBody(null, 500).code).toBe('FEATURE_NEEDS_INTERNET');
    expect(
      mapAgentProxyErrorBody({ code: 'RATE_LIMITED', message: 'x', retryAfter: 3 }, 429).code
    ).toBe('RATE_LIMITED');
  });
  it('a body-less gateway status keeps the generic mapping', () => {
    expect(mapAgentProxyErrorBody(null, 503).code).toBe('AGENT_ERROR');
  });
});

describe('nested INTERNAL keeps the caller mapping', () => {
  it('agent-proxy: INTERNAL maps to AGENT_ERROR', () => {
    expect(mapAgentProxyErrorBody({ code: 'INTERNAL', message: 'x' }, 500).code).toBe('AGENT_ERROR');
  });
  it('receipt email: INTERNAL maps to SUPABASE_ERROR', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: httpError(500, { success: false, error: { code: 'INTERNAL', message: 'x' } }),
    });
    const result = await callSendReceiptEmail({ email: 'cliente@example.com', receiptPlainText: 'ticket' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SUPABASE_ERROR');
  });
});

describe('body-less 4xx on the email functions (expired JWT, 404, 413)', () => {
  it.each([401, 404, 413])('receipt email: a body-less %i maps to SUPABASE_ERROR', async status => {
    invokeMock.mockResolvedValue({ data: null, error: httpError(status, { message: 'Invalid JWT' }) });
    const result = await callSendReceiptEmail({ email: 'cliente@example.com', receiptPlainText: 'ticket' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SUPABASE_ERROR');
  });
  it.each([401, 404, 413])('test email: a body-less %i maps to SUPABASE_ERROR', async status => {
    invokeMock.mockResolvedValue({ data: null, error: httpError(status, { message: 'Invalid JWT' }) });
    const result = await callSendSettingsTestEmail({ email: 'cliente@example.com' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SUPABASE_ERROR');
  });
});

describe('callAgentProxy gateway 503', () => {
  it.each(gateway503s)(
    'a gateway 503 %s with Retry-After is not "needs internet"',
    async (code, retryAfter) => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ code }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': retryAfter },
        })
      );
      const result = await callAgentProxy(agentRequest);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).not.toBe('FEATURE_NEEDS_INTERNET');
    }
  );
});

describe('callAgentProxy transport failure', () => {
  it('a rejected fetch (the till cannot reach its own server) is not "needs internet"', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await callAgentProxy(agentRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).not.toBe('FEATURE_NEEDS_INTERNET');
  });
});

describe('email calls', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });
  const receipt = { email: 'cliente@example.com', receiptPlainText: 'ticket' };

  it('receipt email: CONFIG is not configured', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: httpError(500, { success: false, error: { code: 'CONFIG', message: 'x' } }),
    });
    const result = await callSendReceiptEmail(receipt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FEATURE_NOT_CONFIGURED');
  });

  it('receipt email: a bare 500 (no internet, no envelope) needs internet', async () => {
    invokeMock.mockResolvedValue({ data: null, error: httpError(500, { error: 'internal' }) });
    const result = await callSendReceiptEmail(receipt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FEATURE_NEEDS_INTERNET');
  });

  it('receipt email: RATE_LIMITED keeps its own message', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: httpError(429, {
        success: false,
        error: { code: 'RATE_LIMITED', message: 'x', retryAfter: 9 },
      }),
    });
    const result = await callSendReceiptEmail(receipt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RATE_LIMITED');
  });

  it.each(gateway503s)(
    'receipt email: a gateway 503 %s is not "needs internet"',
    async (code, retryAfter) => {
      invokeMock.mockResolvedValue({
        data: null,
        error: httpError(503, { code }, { 'Retry-After': retryAfter }),
      });
      const result = await callSendReceiptEmail(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).not.toBe('FEATURE_NEEDS_INTERNET');
    }
  );

  it('receipt email: a transport failure (no response) is not "needs internet"', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: new Error('Failed to send a request to the Edge Function'),
    });
    const result = await callSendReceiptEmail(receipt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).not.toBe('FEATURE_NEEDS_INTERNET');
  });

  it('test email: CONFIG is not configured, never the raw supabase-js string', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: httpError(500, { ok: false, error: { code: 'CONFIG', message: 'Server misconfigured' } }),
    });
    const result = await callSendSettingsTestEmail({ email: 'cliente@example.com' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FEATURE_NOT_CONFIGURED');
      expect(result.error.message).not.toMatch(/non-2xx/i);
    }
  });

  it('test email: RESEND_ERROR needs internet', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: httpError(502, { ok: false, error: { code: 'RESEND_ERROR', message: 'x' } }),
    });
    const result = await callSendSettingsTestEmail({ email: 'cliente@example.com' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FEATURE_NEEDS_INTERNET');
  });

  it.each(gateway503s)(
    'test email: a gateway 503 %s is not "needs internet"',
    async (code, retryAfter) => {
      invokeMock.mockResolvedValue({
        data: null,
        error: httpError(503, { code }, { 'Retry-After': retryAfter }),
      });
      const result = await callSendSettingsTestEmail({ email: 'cliente@example.com' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).not.toBe('FEATURE_NEEDS_INTERNET');
    }
  );
});
