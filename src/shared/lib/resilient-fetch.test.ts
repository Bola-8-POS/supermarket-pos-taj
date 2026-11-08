import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isAuthRefreshRequest,
  isServerUnreachableStatus,
  markUnreachableRestResponse,
  softenRefreshResponse,
  withResilientResponses,
} from './resilient-fetch';
import { SERVER_UNREACHABLE_CODE } from './result';

/** Gateway 503 envelopes (conventions v1.6 §8.1): outcome unknown / request never ran. */
function gateway503(code: 'UPSTREAM_UNAVAILABLE' | 'STORE_UPDATING'): Response {
  return new Response(JSON.stringify({ code, message: 'gateway says wait' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': code === 'STORE_UPDATING' ? '30' : '5',
    },
  });
}

describe('isServerUnreachableStatus', () => {
  it.each([502, 503, 504])('%i means the server could not be reached', status => {
    expect(isServerUnreachableStatus(status)).toBe(true);
  });
  it.each([200, 400, 401, 403, 404, 409, 429, 500, 501])('%i is a real server verdict', status => {
    expect(isServerUnreachableStatus(status)).toBe(false);
  });
});

describe('markUnreachableRestResponse', () => {
  it.each([502, 504])(
    'turns an empty %i (a proxy that died) into a typed error with the same status',
    async status => {
      const res = await markUnreachableRestResponse(new Response('', { status }));
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code: SERVER_UNREACHABLE_CODE });
    }
  );

  it('turns an HTML 503 (a proxy error page) into a typed error', async () => {
    const res = await markUnreachableRestResponse(
      new Response('<html>Service Unavailable</html>', {
        status: 503,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: SERVER_UNREACHABLE_CODE });
  });

  it.each(['UPSTREAM_UNAVAILABLE', 'STORE_UPDATING'] as const)(
    'turns the gateway %s 503 envelope (Retry-After set) into a typed error, status kept',
    async code => {
      const res = await markUnreachableRestResponse(gateway503(code));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: SERVER_UNREACHABLE_CODE });
    }
  );

  it('never treats a 400 as unreachable, even with an empty body (R3A C4-2 carried a JSON body; an empty 400 is not an outage signal)', async () => {
    const res = await markUnreachableRestResponse(new Response('', { status: 400 }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('');
  });

  it('leaves a real PostgREST 400 (JSON body with a code) untouched', async () => {
    const body = JSON.stringify({
      code: '23514',
      message: 'violates check constraint',
      details: null,
      hint: null,
    });
    const res = await markUnreachableRestResponse(new Response(body, { status: 400 }));
    expect(await res.json()).toMatchObject({ code: '23514' });
  });

  it('leaves a 500 with a JSON error body untouched (a real server verdict)', async () => {
    const res = await markUnreachableRestResponse(
      new Response(JSON.stringify({ code: 'P0001', message: 'x' }), { status: 500 })
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'P0001' });
  });

  it('leaves a 200 untouched', async () => {
    const res = await markUnreachableRestResponse(
      new Response(JSON.stringify([{ id: 1 }]), { status: 200 })
    );
    expect(await res.json()).toEqual([{ id: 1 }]);
  });
});

describe('withResilientResponses', () => {
  it('rewrites only /rest/v1/ requests', async () => {
    const wrapped = withResilientResponses(async () => gateway503('UPSTREAM_UNAVAILABLE'));
    const fn = await wrapped('http://127.0.0.1:1/functions/v1/anything', { method: 'POST' });
    expect(await fn.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    const rest = await wrapped('http://127.0.0.1:1/rest/v1/rpc/anything', { method: 'POST' });
    expect(rest.status).toBe(503);
    expect(await rest.json()).toMatchObject({ code: SERVER_UNREACHABLE_CODE });
  });

  it('passes a fetch rejection through unchanged', async () => {
    const wrapped = withResilientResponses(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(wrapped('http://127.0.0.1:1/rest/v1/products')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('isAuthRefreshRequest', () => {
  it('matches the POST token refresh call only', () => {
    const base = 'http://127.0.0.1:1/auth/v1/token';
    expect(isAuthRefreshRequest(`${base}?grant_type=refresh_token`, { method: 'POST' })).toBe(true);
    expect(isAuthRefreshRequest(`${base}?grant_type=password`, { method: 'POST' })).toBe(false);
    expect(isAuthRefreshRequest(`${base}?grant_type=refresh_token`, { method: 'GET' })).toBe(false);
    expect(isAuthRefreshRequest('http://127.0.0.1:1/auth/v1/logout', { method: 'POST' })).toBe(false);
  });
});

describe('softenRefreshResponse', () => {
  it.each([500, 501, 505, 599, 429])('turns a transient %i into a retryable 503', status => {
    const res = softenRefreshResponse(new Response(JSON.stringify({ msg: 'x' }), { status }));
    expect(res.status).toBe(503);
  });
  it.each([502, 503, 504])('leaves %i alone (auth-js already retries it)', status => {
    const original = status === 503 ? gateway503('UPSTREAM_UNAVAILABLE') : new Response('{}', { status });
    expect(softenRefreshResponse(original).status).toBe(status);
  });
  it.each([400, 401, 403, 422])('leaves a real %i refusal alone so a revoked session still ends', status => {
    expect(softenRefreshResponse(new Response('{}', { status })).status).toBe(status);
  });
  it('leaves a 200 alone', () => {
    expect(softenRefreshResponse(new Response('{}', { status: 200 })).status).toBe(200);
  });
});

describe('auth-js contract: what the cashier keeps (R3A b1)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function refreshAgainst(base: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    const client = createClient('http://127.0.0.1:1', 'anon-test-value', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: base },
    });
    const events: string[] = [];
    client.auth.onAuthStateChange(event => {
      events.push(event);
    });
    await client.auth.getSession();
    const pending = client.auth.refreshSession({ refresh_token: 'refresh-test-value' });
    // auth-js backs off 200 ms, 400 ms... for up to one 30 s tick on a retryable error.
    await vi.advanceTimersByTimeAsync(31_000);
    const { error } = await pending;
    return { events, error };
  }

  const answer500 = () =>
    Promise.resolve(
      new Response(JSON.stringify({ code: 500, error_code: 'unexpected_failure', msg: 'simulated outage' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

  it('CONTROL: a raw 500 on refresh makes auth-js drop the session (SIGNED_OUT)', async () => {
    vi.useFakeTimers();
    const { events, error } = await refreshAgainst(answer500);
    expect(events).toContain('SIGNED_OUT');
    expect(error?.name).toBe('AuthApiError');
  });

  it('through the wrapper, the same 500 is retryable: no SIGNED_OUT', async () => {
    vi.useFakeTimers();
    const { events, error } = await refreshAgainst(withResilientResponses(answer500));
    expect(events).not.toContain('SIGNED_OUT');
    expect(error?.name).toBe('AuthRetryableFetchError');
  });

  it('through the wrapper, a real 400 refusal still signs out', async () => {
    vi.useFakeTimers();
    const refused = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      );
    const { events } = await refreshAgainst(withResilientResponses(refused));
    expect(events).toContain('SIGNED_OUT');
  });
});
