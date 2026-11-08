/**
 * The two fixed-UUID integration-test fixture staff accounts that
 * scripts/setup-test-fixtures.ts provisions: a cashier and a manager, both
 * under the @barpos.dev domain (never @barpos.local — that domain is every
 * real staff member's address, see create-staff). Ids and emails are not
 * secrets and are the single source of truth both setup-test-fixtures.ts and
 * every integration test that signs in as one of these accounts import from
 * here.
 *
 * PINs are never literals: fixturePin(role) reads
 * E2E_FIXTURE_CASHIER_PIN / E2E_FIXTURE_MANAGER_PIN from process.env, and
 * only when called — never at module scope. A script's dotenv.config() runs
 * after its imports, and Vitest integration workers only see what
 * src/test/global-setup.ts has already put on process.env by the time a
 * test body runs; reading eagerly at import time would race both.
 */

export type FixtureRole = 'cashier' | 'manager';

export interface FixtureAccount {
  id: string;
  name: string;
  email: string;
  role: FixtureRole;
}

export const FIXTURE_ACCOUNTS: Record<FixtureRole, FixtureAccount> = {
  cashier: {
    id: '4d77ef2b-c99d-4dd1-a572-2638ab427496',
    name: 'Alex Martinez',
    email: 'alex@barpos.dev',
    role: 'cashier',
  },
  manager: {
    id: 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e',
    name: 'Jamie Chen',
    email: 'jamie@barpos.dev',
    role: 'manager',
  },
};

const FIXTURE_PIN_ENV_KEYS: Record<FixtureRole, string> = {
  cashier: 'E2E_FIXTURE_CASHIER_PIN',
  manager: 'E2E_FIXTURE_MANAGER_PIN',
};

/**
 * Reads the fixture PIN for `role` from process.env. Throws, naming the
 * missing key and .env.example, when it is not set. Never call this at
 * module scope — call it inside a beforeAll/beforeEach or a describe body
 * already guarded by haveFixturePins().
 */
export function fixturePin(role: FixtureRole): string {
  const key = FIXTURE_PIN_ENV_KEYS[role];
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing ${key} in the environment; see .env.example`);
  }
  return value;
}

/**
 * True when both fixture PIN env keys are set. The integration tests that
 * sign in as these accounts wrap their describe block in
 * describe.skipIf(!haveFixturePins()), the repo's existing skip-when-missing
 * convention (see e2e/helpers/requireEnv.ts).
 */
export function haveFixturePins(): boolean {
  return Object.values(FIXTURE_PIN_ENV_KEYS).every(key => Boolean(process.env[key]));
}
