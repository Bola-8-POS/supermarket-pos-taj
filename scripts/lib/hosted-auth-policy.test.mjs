import { describe, expect, it } from 'vitest';

import { HOSTED_AUTH_POLICY, INFO_FIELDS, evaluateHostedAuth, printableConfig } from './hosted-auth-policy.mjs';

/** A hosted Auth config that satisfies every HOSTED_AUTH_POLICY rule and carries every INFO_FIELDS entry. */
function compliantConfig() {
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
    uri_allow_list: '',
    jwt_exp: 3600,
    security_refresh_token_reuse_interval: 10,
    security_captcha_enabled: false,
    mfa_totp_enroll_enabled: true,
    mfa_totp_verify_enabled: true,
  };
}

const KNOWN_SECRET_NAMED_FIELDS = ['smtp_pass', 'hook_send_email_secrets', 'sms_twilio_auth_token', 'service_role_key', 'anon_key'];

describe('HOSTED_AUTH_POLICY', () => {
  it('lists only policy fields, none of them a known secret-named field', () => {
    const fields = Object.keys(HOSTED_AUTH_POLICY);
    expect(fields).toContain('disable_signup');
    expect(fields).toContain('password_min_length');
    for (const secretField of KNOWN_SECRET_NAMED_FIELDS) {
      expect(fields).not.toContain(secretField);
    }
  });
});

describe('evaluateHostedAuth', () => {
  it('reports ok, no mismatches and an empty patch for a compliant config', () => {
    const result = evaluateHostedAuth(compliantConfig());
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.patch).toEqual({});
  });

  it('reports the exact mismatches and patch for a config with signup on and a raised rate limit', () => {
    const config = { ...compliantConfig(), disable_signup: false, rate_limit_token_refresh: 500 };
    const result = evaluateHostedAuth(config);

    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        { field: 'disable_signup', expected: true, actual: false },
        { field: 'rate_limit_token_refresh', expected: '<= 150', actual: 500 },
      ])
    );
    expect(result.mismatches).toHaveLength(2);
    expect(result.patch).toEqual({ disable_signup: true, rate_limit_token_refresh: 150 });
  });

  it('reports a field missing from the response as absent info, never as a mismatch', () => {
    const config = compliantConfig();
    delete config.rate_limit_sms_sent;
    const result = evaluateHostedAuth(config);

    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.patch).toEqual({});
    expect(result.info.rate_limit_sms_sent).toBe('absent');
  });

  it('treats an empty-string, null or undefined password_required_characters as compliant', () => {
    for (const value of ['', null, undefined]) {
      const config = { ...compliantConfig(), password_required_characters: value };
      if (value === undefined) delete config.password_required_characters;
      const result = evaluateHostedAuth(config);
      expect(result.ok).toBe(true);
    }
  });

  it('patches password_required_characters to an empty string when non-empty', () => {
    const config = { ...compliantConfig(), password_required_characters: 'letters_digits' };
    const result = evaluateHostedAuth(config);
    expect(result.ok).toBe(false);
    expect(result.patch.password_required_characters).toBe('');
  });

  it('never puts an INFO_FIELDS entry into mismatches or patch', () => {
    const config = { ...compliantConfig(), site_url: 'http://unexpected.example', uri_allow_list: 'http://a,http://b' };
    const result = evaluateHostedAuth(config);
    expect(result.ok).toBe(true);
    expect(result.patch).toEqual({});
    for (const field of INFO_FIELDS) {
      expect(result.mismatches.some((m) => m.field === field)).toBe(false);
    }
  });
});

describe('printableConfig', () => {
  it('allow-lists only policy and info fields, dropping every secret-named key', () => {
    const config = {
      ...compliantConfig(),
      smtp_pass: 'SYNTHETIC_SMTP_PASS_VALUE',
      hook_send_email_secrets: 'SYNTHETIC_HOOK_SECRET_VALUE',
      sms_twilio_auth_token: 'SYNTHETIC_TWILIO_TOKEN_VALUE',
      api_key: 'SYNTHETIC_API_KEY_VALUE',
    };
    const printable = printableConfig(config);
    const serialized = JSON.stringify(printable);

    expect(serialized).not.toContain('SYNTHETIC_SMTP_PASS_VALUE');
    expect(serialized).not.toContain('SYNTHETIC_HOOK_SECRET_VALUE');
    expect(serialized).not.toContain('SYNTHETIC_TWILIO_TOKEN_VALUE');
    expect(serialized).not.toContain('SYNTHETIC_API_KEY_VALUE');
    expect(printable).not.toHaveProperty('smtp_pass');
    expect(printable).not.toHaveProperty('hook_send_email_secrets');
    expect(printable).not.toHaveProperty('sms_twilio_auth_token');
    expect(printable).not.toHaveProperty('api_key');

    for (const field of [...Object.keys(HOSTED_AUTH_POLICY), ...INFO_FIELDS]) {
      expect(printable).toHaveProperty(field);
    }
  });

  it('marks an absent allow-listed field as the string "absent"', () => {
    const config = compliantConfig();
    delete config.jwt_exp;
    const printable = printableConfig(config);
    expect(printable.jwt_exp).toBe('absent');
  });
});
