import { callStaffSignIn, completeStaffSignIn, signInMessage } from './staff-sign-in';

const config = { url: 'https://proj.supabase.co', anonKey: 'anon-key' };
const reply = (status: number, body: unknown) => async () =>
  ({ status, json: async () => body }) as unknown as Response;
const run = (status: number, body: unknown) =>
  callStaffSignIn(config, 'staff-1', '1234', reply(status, body));

describe('callStaffSignIn timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('aborts a hung request after 10 s and returns UNAVAILABLE', async () => {
    let seen: AbortSignal | undefined;
    const hung = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const pending = callStaffSignIn(config, 'staff-1', '123456', hung as unknown as typeof fetch);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ kind: 'UNAVAILABLE' });
    expect(seen).toBeDefined();
  });

  it('leaves no pending timer after a fast 200', async () => {
    const fast = reply(200, { accessToken: 'a', refreshToken: 'r', mustChangePin: false });
    expect(await callStaffSignIn(config, 's', '123456', fast)).toMatchObject({ kind: 'ok' });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('callStaffSignIn', () => {
  it('returns the tokens on 200', async () => {
    const fetchFn = jest.fn(reply(200, { accessToken: 'a', refreshToken: 'r', mustChangePin: false }));
    const result = await callStaffSignIn(config, 'staff-1', '1234', fetchFn);
    expect(result).toEqual({ kind: 'ok', accessToken: 'a', refreshToken: 'r', mustChangePin: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proj.supabase.co/functions/v1/staff-sign-in');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      apikey: 'anon-key',
      Authorization: 'Bearer anon-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({ staffId: 'staff-1', pin: '1234' });
  });

  it('passes mustChangePin through on 200', async () => {
    const r = await run(200, { accessToken: 'a', refreshToken: 'r', mustChangePin: true });
    expect(r).toMatchObject({ kind: 'ok', mustChangePin: true });
  });

  it('maps the function\'s own 401 to INVALID_CREDENTIALS', async () => {
    expect(await run(401, { error: 'INVALID_CREDENTIALS', retryAfter: 0 })).toEqual({ kind: 'INVALID_CREDENTIALS' });
  });

  it('maps a 401 that did not come from the function to UNAVAILABLE', async () => {
    const bad = async () =>
      ({
        status: 401,
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response;
    expect(await callStaffSignIn(config, 's', '1', bad)).toEqual({ kind: 'UNAVAILABLE' });
    expect(await run(401, { message: 'Invalid JWT' })).toEqual({ kind: 'UNAVAILABLE' });
    expect(await run(401, { error: 'invalid_token' })).toEqual({ kind: 'UNAVAILABLE' });
    expect(await run(401, 'nope')).toEqual({ kind: 'UNAVAILABLE' });
    expect(await run(401, null)).toEqual({ kind: 'UNAVAILABLE' });
  });

  it('maps 429 to LOCKED and keeps retryAfter', async () => {
    expect(await run(429, { error: 'LOCKED', retryAfter: 45 })).toEqual({ kind: 'LOCKED', retryAfter: 45 });
  });

  it.each([
    ['missing', {}],
    ['non-numeric', { retryAfter: 'soon' }],
    ['NaN-ish string', { retryAfter: '12' }],
    ['null', { retryAfter: null }],
    ['zero', { retryAfter: 0 }],
    ['negative', { retryAfter: -5 }],
    ['Infinity-like', { retryAfter: 1e999 }],
  ])('defaults LOCKED retryAfter to 60 when %s', async (_n, body) => {
    expect(await run(429, { error: 'LOCKED', ...body })).toEqual({ kind: 'LOCKED', retryAfter: 60 });
  });

  it('rounds a fractional retryAfter up', async () => {
    expect(await run(429, { error: 'LOCKED', retryAfter: 1.2 })).toEqual({ kind: 'LOCKED', retryAfter: 2 });
  });

  it('maps 503 to UNAVAILABLE', async () => {
    expect(await run(503, { error: 'UNAVAILABLE' })).toEqual({ kind: 'UNAVAILABLE' });
  });

  it('maps a network failure, a 5xx, a 400 and an unparseable body to UNAVAILABLE without raw text', async () => {
    const boom = async () => {
      throw new TypeError('Network request failed: secret-host');
    };
    expect(await callStaffSignIn(config, 's', '1', boom)).toEqual({ kind: 'UNAVAILABLE' });
    expect(await run(500, { error: 'raw server text' })).toEqual({ kind: 'UNAVAILABLE' });
    expect(await run(400, { error: 'INVALID_REQUEST' })).toEqual({ kind: 'UNAVAILABLE' });
    const bad = async () =>
      ({
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response;
    expect(await callStaffSignIn(config, 's', '1', bad)).toEqual({ kind: 'UNAVAILABLE' });
  });

  it('rejects a malformed 200 body', async () => {
    expect(await run(200, { accessToken: 'a', mustChangePin: false })).toEqual({ kind: 'UNAVAILABLE' });
    expect(await run(200, { accessToken: 'a', refreshToken: '', mustChangePin: false })).toEqual({
      kind: 'UNAVAILABLE',
    });
  });
});

describe('completeStaffSignIn', () => {
  const okBody = (mustChangePin: boolean) => ({ accessToken: 'a', refreshToken: 'r', mustChangePin });
  const go = (fetchFn: typeof fetch, setSession: jest.Mock) =>
    completeStaffSignIn(config, 'staff-1', '123456', { fetchFn, auth: { setSession } });

  it('hands exactly the two tokens to setSession and returns ok without them', async () => {
    const setSession = jest.fn(async () => ({ error: null }));
    const result = await go(reply(200, okBody(false)) as unknown as typeof fetch, setSession);
    expect(setSession).toHaveBeenCalledTimes(1);
    expect(setSession).toHaveBeenCalledWith({ access_token: 'a', refresh_token: 'r' });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('never calls setSession when the PIN must be changed', async () => {
    const setSession = jest.fn(async () => ({ error: null }));
    const result = await go(reply(200, okBody(true)) as unknown as typeof fetch, setSession);
    expect(result).toEqual({ kind: 'MUST_CHANGE_PIN' });
    expect(setSession).not.toHaveBeenCalled();
  });

  it('maps a setSession error to UNAVAILABLE', async () => {
    const setSession = jest.fn(async () => ({ error: { message: 'raw' } }));
    const result = await go(reply(200, okBody(false)) as unknown as typeof fetch, setSession);
    expect(result).toEqual({ kind: 'UNAVAILABLE' });
  });

  it('maps a throwing setSession to UNAVAILABLE', async () => {
    const setSession = jest.fn(async () => {
      throw new Error('storage failed');
    });
    const result = await go(reply(200, okBody(false)) as unknown as typeof fetch, setSession);
    expect(result).toEqual({ kind: 'UNAVAILABLE' });
  });

  it('returns a failed sign-in as is without setSession', async () => {
    const setSession = jest.fn(async () => ({ error: null }));
    const result = await go(reply(401, { error: 'INVALID_CREDENTIALS' }) as unknown as typeof fetch, setSession);
    expect(result).toEqual({ kind: 'INVALID_CREDENTIALS' });
    expect(setSession).not.toHaveBeenCalled();
  });
});

describe('sign-in guards', () => {
  const PIN = String(987654);
  const ACCESS = 'access-token-sentinel';
  const REFRESH = 'refresh-token-sentinel';
  const EMAIL = 'admin@barpos.local';
  const okBody = (mustChangePin: boolean) => ({ accessToken: ACCESS, refreshToken: REFRESH, mustChangePin });
  const okSession = jest.fn(async () => ({ error: null }));

  it('never sends the email', async () => {
    // A profile-shaped object exists in the caller; only its id may reach the wire.
    const profile = { id: 'staff-1', email: EMAIL };
    const fetchFn = jest.fn(reply(200, okBody(false)));
    await completeStaffSignIn(config, profile.id, PIN, {
      fetchFn: fetchFn as unknown as typeof fetch,
      auth: { setSession: okSession },
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(['pin', 'staffId']);
    expect(JSON.stringify([url, init])).not.toContain(EMAIL);
    expect(JSON.stringify([url, init])).not.toContain('email');
  });

  it('never logs the pin', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m));
    const boom = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const f = (status: number, body: unknown) => reply(status, body) as unknown as typeof fetch;
    const session = (impl: () => Promise<{ error: unknown }>) => ({ setSession: jest.fn(impl) });
    const cases: [typeof fetch, { setSession: jest.Mock }][] = [
      [f(200, okBody(false)), session(async () => ({ error: null }))],
      [f(200, okBody(true)), session(async () => ({ error: null }))],
      [f(401, { error: 'INVALID_CREDENTIALS' }), session(async () => ({ error: null }))],
      [f(429, { error: 'LOCKED', retryAfter: 30 }), session(async () => ({ error: null }))],
      [f(503, { error: 'UNAVAILABLE' }), session(async () => ({ error: null }))],
      [boom, session(async () => ({ error: null }))],
      [f(200, okBody(false)), session(async () => ({ error: { message: 'raw' } }))],
      [
        f(200, okBody(false)),
        session(async () => {
          throw new Error('storage failed');
        }),
      ],
    ];
    try {
      for (const [fetchFn, auth] of cases) await completeStaffSignIn(config, 'staff-1', PIN, { fetchFn, auth });
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      for (const secret of [PIN, ACCESS, REFRESH]) expect(logged).not.toContain(secret);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('a locked answer does not call setSession', async () => {
    const setSession = jest.fn(async () => ({ error: null }));
    const result = await completeStaffSignIn(config, 'staff-1', PIN, {
      fetchFn: reply(429, { error: 'LOCKED', retryAfter: 30, ...okBody(false) }) as unknown as typeof fetch,
      auth: { setSession },
    });
    expect(result).toEqual({ kind: 'LOCKED', retryAfter: 30 });
    expect(setSession).not.toHaveBeenCalled();
  });
});

describe('signInMessage', () => {
  it('words each failure without revealing which input was wrong', () => {
    expect(signInMessage({ kind: 'INVALID_CREDENTIALS' })).toBe('Wrong PIN.');
    expect(signInMessage({ kind: 'UNAVAILABLE' })).toBe('Sign-in is unavailable right now. Try again shortly.');
  });

  it('says what to do when the PIN must be changed first', () => {
    expect(signInMessage({ kind: 'MUST_CHANGE_PIN' })).toBe(
      'Your PIN must be changed first. Change it in the POS app, then sign in here.'
    );
  });

  it.each([
    [45, 'Too many attempts. Try again in 45 seconds.'],
    [1, 'Too many attempts. Try again in 1 second.'],
    [59, 'Too many attempts. Try again in 59 seconds.'],
    [60, 'Too many attempts. Try again in 1 minute.'],
    [61, 'Too many attempts. Try again in 2 minutes.'],
    [300, 'Too many attempts. Try again in 5 minutes.'],
  ])('LOCKED %i s', (retryAfter, text) => {
    expect(signInMessage({ kind: 'LOCKED', retryAfter })).toBe(text);
  });
});
