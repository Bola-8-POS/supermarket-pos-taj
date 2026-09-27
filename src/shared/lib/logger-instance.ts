/**
 * APP-LEVEL LOGGER INSTANCE
 *
 * This is the singleton logger instance used throughout the application.
 * Import this instead of creating new loggers.
 *
 * @example
 * ```typescript
 * import { logger } from '@shared/lib/logger-instance'
 *
 * logger.info('tab.opened', { tabId: tab.id })
 * logger.error('payment.failed', { tabId: tab.id }, error)
 * ```
 */

import { createLogger } from './logger';
import { getTerminalId } from './terminal';

// Get app version from environment
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) || '0.0.0';

// Generate session ID (unique per app session)
const SESSION_ID = crypto.randomUUID();

/**
 * Global logger instance.
 *
 * Use this throughout the application for all logging.
 */
export const logger = createLogger({
  terminalId: getTerminalId, // resolver, not a snapshot -- re-read on every log call
  appVersion: APP_VERSION,
  sessionId: SESSION_ID,
});
