import { describe, expect, it, vi } from 'vitest';

import { main } from './check-hosted-auth.mjs';

const REF = 'syntheticprojectrefx';
const CONFIG_URL = `https://api.supabase.com/v1/projects/${REF}/config/auth`;

/** A hosted Auth config that satisfies every HOSTED_AUTH_POLICY rule. */
function compliantConfig(overrides = {}) {
  return {
    disable_signup: true,
    external_anonymous_users_enabled: false,
    external_email_enabled: true,
    security_manual_linking_enabled: false,
    refresh_token_rotation_enabled: true,
    mailer_autoconfirm: false,
    security_update_password_require_reauthentication: false,
    password_hibp_enabled: false,
    password_min_length: 6,
    password_required_characters: '',
    rate_limit_token_refresh: 150,
    rate_limit_verify: 30,
    rate_limit_email_sent: 2,
    rate_limit_otp: 30,
    rate_limit_anonymous_users: 30,
    rate_limit_sms_sent: 30,
    site_url: 'http://localhost:3000',
    ...overrides,
  };
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body ?? {}),
  };
}

function makeDeps(overrides = {}) {
  return {
    fetch: vi.fn(),
    env: {},
    log: vi.fn(),
    error: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    readManifest: vi.fn(() => [{ name: 'demo', supabase_project_ref: REF }]),
    ...overrides,
  };
}

describe('check-hosted-auth main()', () => {
  it('exits 2 and names the variable when SUPABASE_ACCESS_TOKEN is absent', async () => {
    const deps = makeDeps({ env: {} });
    const code = await main(['--project-ref', REF], deps);
    expect(code).toBe(2);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.error.mock.calls.flat().join(' ')).toContain('SUPABASE_ACCESS_TOKEN');
  });

  it('exits 2 when --apply targets a ref absent from the manifest fixture', async () => {
    const deps = makeDeps({
      env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token' },
      readManifest: vi.fn(() => [{ name: 'demo', supabase_project_ref: 'a-different-ref' }]),
    });
    const code = await main(['--project-ref', REF, '--apply'], deps);
    expect(code).toBe(2);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('exits 3 on a GET 401, printing only the message field from the body', async () => {
    const deps = makeDeps({ env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token' } });
    deps.fetch.mockResolvedValueOnce(
      jsonResponse(401, { message: 'Invalid authentication credentials', extra_secret_field: 'SYNTHETIC_SECRET' })
    );
    const code = await main(['--project-ref', REF], deps);
    expect(code).toBe(3);
    const printed = deps.error.mock.calls.flat().join(' ');
    expect(printed).toContain('401');
    expect(printed).toContain('Invalid authentication credentials');
    expect(printed).not.toContain('SYNTHETIC_SECRET');
    expect(printed).not.toContain('extra_secret_field');
  });

  it('exits 1 and prints field/expected/actual lines for a mismatch without --apply', async () => {
    const deps = makeDeps({ env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token' } });
    deps.fetch.mockResolvedValueOnce(jsonResponse(200, compliantConfig({ disable_signup: false })));
    const code = await main(['--project-ref', REF], deps);
    expect(code).toBe(1);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    const printed = deps.log.mock.calls.flat().join('\n');
    expect(printed).toContain('disable_signup');
    expect(printed).toContain('true');
    expect(printed).toContain('false');
  });

  it('applies: PATCHes exactly the patch object, re-GETs, and exits 0 when the second read is compliant', async () => {
    const deps = makeDeps({ env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token' } });
    deps.fetch
      .mockResolvedValueOnce(jsonResponse(200, compliantConfig({ disable_signup: false })))
      .mockResolvedValueOnce(jsonResponse(200, { message: 'ok' }))
      .mockResolvedValueOnce(jsonResponse(200, compliantConfig()));

    const code = await main(['--project-ref', REF, '--apply'], deps);

    expect(deps.fetch).toHaveBeenCalledTimes(3);
    const [, patchArgs] = deps.fetch.mock.calls;
    expect(patchArgs[0]).toBe(CONFIG_URL);
    expect(patchArgs[1].method).toBe('PATCH');
    expect(JSON.parse(patchArgs[1].body)).toEqual({ disable_signup: true });
    expect(code).toBe(0);
  });

  it('applies and exits 1 when the second GET is still non-compliant', async () => {
    const deps = makeDeps({ env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token' } });
    deps.fetch
      .mockResolvedValueOnce(jsonResponse(200, compliantConfig({ disable_signup: false })))
      .mockResolvedValueOnce(jsonResponse(200, { message: 'ok' }))
      .mockResolvedValueOnce(jsonResponse(200, compliantConfig({ disable_signup: false })));

    const code = await main(['--project-ref', REF, '--apply'], deps);
    expect(code).toBe(1);
  });

  it('retries once after a 429, waiting min(Retry-After, 60) seconds', async () => {
    const deps = makeDeps({ env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token' } });
    deps.fetch
      .mockResolvedValueOnce(jsonResponse(429, { message: 'Rate limit exceeded' }, { 'retry-after': '90' }))
      .mockResolvedValueOnce(jsonResponse(200, compliantConfig()));

    const code = await main(['--project-ref', REF], deps);

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledWith(60_000);
    expect(code).toBe(0);
  });

  it('waits 10 seconds on a 429 with no Retry-After header', async () => {
    const deps = makeDeps({ env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token' } });
    deps.fetch
      .mockResolvedValueOnce(jsonResponse(429, { message: 'Rate limit exceeded' }))
      .mockResolvedValueOnce(jsonResponse(200, compliantConfig()));

    const code = await main(['--project-ref', REF], deps);

    expect(deps.sleep).toHaveBeenCalledWith(10_000);
    expect(code).toBe(0);
  });

  it('exits 0 without printing anything but a success line when the config is already compliant', async () => {
    const deps = makeDeps({ env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token' } });
    deps.fetch.mockResolvedValueOnce(jsonResponse(200, compliantConfig()));
    const code = await main(['--project-ref', REF], deps);
    expect(code).toBe(0);
  });

  it('never prints a value from a secret-named field, even under a mismatch', async () => {
    const deps = makeDeps({ env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token' } });
    deps.fetch.mockResolvedValueOnce(
      jsonResponse(
        200,
        compliantConfig({
          disable_signup: false,
          smtp_pass: 'SYNTHETIC_SMTP_PASS',
          hook_send_email_secrets: 'SYNTHETIC_HOOK_SECRET',
          sms_twilio_auth_token: 'SYNTHETIC_TWILIO_TOKEN',
        })
      )
    );
    const code = await main(['--project-ref', REF], deps);
    expect(code).toBe(1);
    const printed = [...deps.log.mock.calls.flat(), ...deps.error.mock.calls.flat()].join('\n');
    expect(printed).not.toContain('SYNTHETIC_SMTP_PASS');
    expect(printed).not.toContain('SYNTHETIC_HOOK_SECRET');
    expect(printed).not.toContain('SYNTHETIC_TWILIO_TOKEN');
  });

  it('never sends the access token anywhere but the Authorization header', async () => {
    const deps = makeDeps({ env: { SUPABASE_ACCESS_TOKEN: 'synthetic-token-value' } });
    deps.fetch.mockResolvedValueOnce(jsonResponse(200, compliantConfig()));
    await main(['--project-ref', REF], deps);
    const printed = [...deps.log.mock.calls.flat(), ...deps.error.mock.calls.flat()].join('\n');
    expect(printed).not.toContain('synthetic-token-value');
    const [, getInit] = deps.fetch.mock.calls[0];
    expect(getInit.headers.Authorization).toBe('Bearer synthetic-token-value');
  });
});
