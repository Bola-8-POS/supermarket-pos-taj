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

import { APP_VERSION } from './app-version';
import { createLogger } from './logger';
import { getTerminalId } from './terminal';

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
