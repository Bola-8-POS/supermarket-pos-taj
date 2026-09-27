import { logger } from '@shared/lib/logger-instance';
import { err, ok, type AppError, type Result } from '@shared/lib/result';
import { activateLicense, FATAL_LICENSE_CODES, heartbeatLicense, startDemo } from './client';
import { useLicenseStore } from './store';
import { getTerminalId, resetTerminalId } from './terminal-id';
import { verifyToken } from './token';
import type { LicensePayload } from './types';

/** Verify a token (signature + terminal match) and persist it. Used by activate, heartbeat, and offline import. */
export async function applyToken(
  token: string,
  licenseKey: string | null
): Promise<Result<LicensePayload>> {
  const verified = await verifyToken(token);
  if (!verified.ok) return verified;
  if (verified.data.terminal_id !== getTerminalId()) {
    return err({
      code: 'LICENSE_ERROR',
      message: 'This license token was issued for a different terminal',
    });
  }
  useLicenseStore.getState().setLicense(token, verified.data, licenseKey);
  return ok(verified.data);
}

/** First-run activation with a license key typed by the store owner. */
export async function activateWithKey(licenseKey: string): Promise<Result<LicensePayload>> {
  const res = await activateLicense(licenseKey);
  if (!res.ok) return err(res.error);
  const applied = await applyToken(res.data.token, licenseKey.trim());
  if (applied.ok) {
    useLicenseStore.getState().markHeartbeat();
    logger.info('license.activated', { plan: applied.data.plan, tenant: applied.data.tenant_slug });
  }
  return applied;
}

/** Self-service demo: provision a 14-day demo tenant bound to this terminal (spec §4.4). */
export async function startDemoTrial(): Promise<Result<LicensePayload>> {
  const res = await startDemo();
  if (!res.ok) return err(res.error);
  const applied = await applyToken(res.data.token, res.data.license_key);
  if (applied.ok) {
    useLicenseStore.getState().markHeartbeat();
    logger.info('license.demo_started', { tenant: applied.data.tenant_slug, until: applied.data.period_end });
  }
  return applied;
}

/** Online demo: an expired/used terminal is throwaway — mint a new id and start over. */
export async function resetTerminalForNewDemo(): Promise<Result<LicensePayload>> {
  useLicenseStore.getState().clearLicense(null);
  useLicenseStore.getState().setLicenseKey(null);
  resetTerminalId();
  return startDemoTrial();
}

/** Fully offline stores paste a portal-issued token instead of activating online. */
export async function importOfflineToken(token: string): Promise<Result<LicensePayload>> {
  const applied = await applyToken(token, null);
  if (applied.ok)
    logger.info('license.offline_token_imported', { lease_until: applied.data.lease_until });
  return applied;
}

/**
 * Refresh the lease. Silent on network errors (offline is a normal state); clears the
 * license only when the server says this terminal/key is no longer valid.
 */
export type HeartbeatOutcome = 'refreshed' | 'skipped' | 'rejected';

export async function runHeartbeat(): Promise<HeartbeatOutcome> {
  const { licenseKey, token } = useLicenseStore.getState();
  if (!licenseKey || !token) return 'skipped';
  const res = await heartbeatLicense(licenseKey);
  if (!res.ok) {
    if (res.error.serverCode && FATAL_LICENSE_CODES.has(res.error.serverCode)) {
      logger.warn('license.heartbeat_rejected', { code: res.error.serverCode });
      useLicenseStore.getState().clearLicense(res.error.message);
      return 'rejected';
    }
    logger.debug('license.heartbeat_skipped', { code: res.error.code, message: res.error.message });
    useLicenseStore.getState().setLastError(res.error.message);
    return 'skipped';
  }
  const applied = await applyToken(res.data.token, licenseKey);
  if (!applied.ok) {
    logger.warn('license.heartbeat_token_invalid', { message: applied.error.message });
    return 'skipped';
  }
  useLicenseStore.getState().markHeartbeat();
  return 'refreshed';
}

/** On startup: re-verify the persisted token so a tampered localStorage entry locks the app. */
export async function revalidateStoredToken(): Promise<void> {
  const { token } = useLicenseStore.getState();
  if (!token) return;
  const verified = await verifyToken(token);
  if (!verified.ok || verified.data.terminal_id !== getTerminalId()) {
    const reason: AppError = verified.ok
      ? { code: 'LICENSE_ERROR', message: 'Stored license belongs to another terminal' }
      : verified.error;
    logger.warn('license.stored_token_invalid', { message: reason.message });
    useLicenseStore.getState().clearLicense(reason.message);
  }
}
