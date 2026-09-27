// Pure policy module for the hosted Supabase Auth config (no I/O, no fetch).
// Consumed by scripts/check-hosted-auth.mjs, which owns the Management API
// calls and the CLI. Kept dependency-free (node: built-ins only, and this
// file needs none) so it stays trivially unit-testable.

/**
 * Every field this project asserts about a hosted project's Auth config,
 * and the rule each one must satisfy:
 * - `eq`: the field must equal this exact value.
 * - `empty`: the field must be null, undefined or "" (an unset character
 *   class requirement — every staff PIN is a bare 6-digit string used as
 *   the Auth password, so a non-empty requirement would reject every PIN).
 * - `max`: the field is a rate limit; it must be <= this ceiling (a lower
 *   value set by an operator is fine and is never flagged).
 *
 * An allow-list, not a deny-list: only fields listed here (plus
 * INFO_FIELDS below) are ever read, compared or printed by this module.
 */
export const HOSTED_AUTH_POLICY = {
  disable_signup: { eq: true },
  external_anonymous_users_enabled: { eq: false },
  external_email_enabled: { eq: true },
  security_manual_linking_enabled: { eq: false },
  refresh_token_rotation_enabled: { eq: true },
  mailer_autoconfirm: { eq: false },
  security_update_password_require_reauthentication: { eq: false },
  password_hibp_enabled: { eq: false },
  password_min_length: { eq: 6 },
  password_required_characters: { empty: true },
  rate_limit_token_refresh: { max: 150 },
  rate_limit_verify: { max: 30 },
  rate_limit_email_sent: { max: 2 },
  rate_limit_otp: { max: 30 },
  rate_limit_anonymous_users: { max: 30 },
  rate_limit_sms_sent: { max: 30 },
};

/** Printed for context, never asserted (no email/redirect flow exists for staff). */
export const INFO_FIELDS = [
  'site_url',
  'uri_allow_list',
  'jwt_exp',
  'security_refresh_token_reuse_interval',
  'security_captcha_enabled',
  'mfa_totp_enroll_enabled',
  'mfa_totp_verify_enabled',
];

function isEmptyValue(value) {
  return value === null || value === undefined || value === '';
}

/**
 * Compares a live `GET config/auth` response against HOSTED_AUTH_POLICY.
 *
 * A field absent from `config` (an undocumented or not-yet-returned field,
 * forward-compatibility with a future GoTrue version) is reported under
 * `info` as `'absent'` and is never a mismatch.
 *
 * @param {Record<string, unknown>} config
 * @returns {{ ok: boolean, mismatches: Array<{field: string, expected: unknown, actual: unknown}>, patch: Record<string, unknown>, info: Record<string, unknown> }}
 */
export function evaluateHostedAuth(config) {
  const mismatches = [];
  const patch = {};
  const info = {};

  for (const [field, rule] of Object.entries(HOSTED_AUTH_POLICY)) {
    if (!(field in config)) {
      info[field] = 'absent';
      continue;
    }
    const actual = config[field];

    if ('eq' in rule) {
      if (actual !== rule.eq) {
        mismatches.push({ field, expected: rule.eq, actual });
        patch[field] = rule.eq;
      }
    } else if ('empty' in rule) {
      if (!isEmptyValue(actual)) {
        mismatches.push({ field, expected: '(empty)', actual });
        patch[field] = '';
      }
    } else if ('max' in rule) {
      if (typeof actual === 'number' && actual > rule.max) {
        mismatches.push({ field, expected: `<= ${rule.max}`, actual });
        patch[field] = rule.max;
      }
    }
  }

  for (const field of INFO_FIELDS) {
    info[field] = field in config ? config[field] : 'absent';
  }

  return { ok: mismatches.length === 0, mismatches, patch, info };
}

/**
 * Copies only the allow-listed fields (HOSTED_AUTH_POLICY + INFO_FIELDS)
 * out of a raw config-auth response, so nothing this module ever prints can
 * carry a value from a secret-named field (`smtp_pass`, `hook_*_secrets`,
 * `sms_twilio_auth_token`, etc.) that the same API response also returns.
 *
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>}
 */
export function printableConfig(config) {
  const out = {};
  for (const field of [...Object.keys(HOSTED_AUTH_POLICY), ...INFO_FIELDS]) {
    out[field] = field in config ? config[field] : 'absent';
  }
  return out;
}
