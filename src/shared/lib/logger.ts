/**
 * STRUCTURED LOGGER â€” PII-Safe, Context-Aware Logging
 *
 * CRITICAL RULES:
 * - NEVER log: card numbers, PINs, Square payment tokens, passwords, full names + amounts
 * - ALL logs are structured objects (not strings)
 * - Log level hierarchy: debug < info < warn < error
 * - PII_GUARD enforced at TypeScript level
 */

// ============================================================================
// PII GUARD â€” Prevents PII from being logged accidentally
// ============================================================================

/**
 * Keys that are BANNED from any log payload.
 * TypeScript will error if you try to log these.
 */
type BannedKeys =
  | 'pin'
  | 'cardNumber'
  | 'cvv'
  | 'squareToken'
  | 'password'
  | 'rawCard'
  | 'cardData'
  | 'paymentToken'
  | 'securityCode'
  | 'fullName' // when combined with amount, this is PII
  | 'referenceNumber'
  | 'terminalReference'
  | 'rappiOrderId';

/**
 * Safe log payload type that prevents PII from being logged.
 *
 * TypeScript will error if you try to include banned keys.
 */
type SafeLogPayload = {
  [K in string]: K extends BannedKeys ? never : unknown;
};

// ============================================================================
// LOG LEVELS
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ============================================================================
// LOG CONTEXT
// ============================================================================

/**
 * Context injected into every log entry automatically.
 */
export type LogContext = {
  terminalId: string; // e.g. "POS-1" (resolved per log call, see TerminalIdInput below)
  userId?: string; // current staff ID (NOT name â€” never log names)
  shiftId?: string;
  sessionId: string; // random UUID per app session (for correlating logs)
  appVersion: string;
};

/**
 * `terminalId` may be a plain string, or a resolver function called fresh on
 * every log entry -- the latter lets `logger-instance.ts` pass
 * `getTerminalId` (Settings/localStorage-backed, can change without reload)
 * instead of a value snapshotted once at logger construction time.
 */
type TerminalIdInput = string | (() => string);

/** Input accepted by `createLogger`/`child` -- same as `LogContext` except
 * `terminalId` may also be a resolver function (see `TerminalIdInput`). */
export type LoggerContextInput = Omit<Partial<LogContext>, 'terminalId'> & {
  terminalId?: TerminalIdInput;
};

// ============================================================================
// LOG ENTRY
// ============================================================================

/**
 * Structured log entry format.
 */
type LogEntry = {
  ts: string; // ISO timestamp
  level: LogLevel;
  event: string; // namespaced: "tab.opened", "payment.failed", "pool.timer.started"
  context: LogContext;
  payload?: SafeLogPayload;
  error?: string; // error.message if raw provided (never full stack in prod)
};

// ============================================================================
// LOGGER INTERFACE
// ============================================================================

export type Logger = {
  debug(event: string, payload?: SafeLogPayload): void;
  info(event: string, payload?: SafeLogPayload): void;
  warn(event: string, payload?: SafeLogPayload): void;
  error(event: string, payload?: SafeLogPayload, raw?: unknown): void;
  child(additionalContext: LoggerContextInput): Logger;
};

// ============================================================================
// LOGGER CONFIGURATION
// ============================================================================

type LoggerConfig = {
  minLevel: LogLevel;
  isDevelopment: boolean;
  isTauri: boolean;
  enableRemoteLogging: boolean;
};

// ============================================================================
// TRANSPORTS
// ============================================================================

/**
 * Console transport for development.
 */
function consoleTransport(entry: LogEntry, isDevelopment: boolean): void {
  if (!isDevelopment) {
    // Production: only log warn and error to console
    if (entry.level !== 'warn' && entry.level !== 'error') {
      return;
    }
  }

  // Color coding
  const colors: Record<LogLevel, string> = {
    debug: '\x1b[90m', // gray
    info: '\x1b[34m', // blue
    warn: '\x1b[33m', // yellow
    error: '\x1b[31m', // red
  };
  const reset = '\x1b[0m';

  const color = colors[entry.level];
  const levelStr = entry.level.toUpperCase().padEnd(5);

  if (isDevelopment) {
    // Pretty-print format for development
    const payloadStr = entry.payload ? JSON.stringify(entry.payload, null, 2) : '';
    const errorStr = entry.error ? `\n  Error: ${entry.error}` : '';

    // eslint-disable-next-line no-console
    console.log(`${color}[${levelStr}]${reset} ${entry.event} ${payloadStr}${errorStr}`);
  } else {
    // Minimal format for production console
    const payloadStr = entry.payload ? JSON.stringify(entry.payload) : '';
    // eslint-disable-next-line no-console
    console[entry.level === 'error' ? 'error' : 'warn'](
      `[${levelStr}] ${entry.event} ${payloadStr}`
    );
  }
}

/**
 * Tauri file transport for production.
 */
async function tauriTransport(entry: LogEntry): Promise<void> {
  try {
    // Dynamic import to avoid errors in non-Tauri environments
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_log', { entry: JSON.stringify(entry) });
  } catch (error) {
    // Fallback to console if Tauri is not available
    console.error('Failed to write log to Tauri:', error);
  }
}

/**
 * Remote transport for production (batched).
 */
let logBatch: LogEntry[] = [];
let batchTimeout: ReturnType<typeof setTimeout> | null = null;

function remoteTransport(entry: LogEntry): void {
  logBatch.push(entry);

  // Batch logs and send every 10 seconds
  if (batchTimeout === null) {
    batchTimeout = setTimeout(() => {
      const batch = [...logBatch];
      logBatch = [];
      batchTimeout = null;

      // Send to Supabase Edge Function
      void fetch('/functions/v1/ingest-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: batch }),
      }).catch((error: unknown) => {
        // Silently fail â€” don't want logging to break the app
        console.error('Failed to send logs to remote:', error);
      });
    }, 10000); // 10 seconds
  }
}

// ============================================================================
// EVENT VALIDATION
// ============================================================================

/**
 * Validates that event names are properly namespaced.
 *
 * Events should follow the pattern: "category.action"
 * Examples: "tab.opened", "payment.failed", "pool.timer.started"
 */
function validateEventName(event: string): void {
  if (!event.includes('.')) {
    console.warn(`[LOGGER] Event name "${event}" is not namespaced. Use format: "category.action"`);
  }
}

// ============================================================================
// LOGGER FACTORY
// ============================================================================

/**
 * Creates a logger instance with the given context.
 *
 * @param context - Base context for all log entries
 * @param config - Logger configuration
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger({
 *   terminalId: 'POS-1', // or a resolver: () => getTerminalId()
 *   sessionId: crypto.randomUUID(),
 *   appVersion: '1.0.0',
 * })
 *
 * logger.info('tab.opened', { tabId: '123' })
 * ```
 */
export function createLogger(context: LoggerContextInput, config?: Partial<LoggerConfig>): Logger {
  // terminalId is resolved fresh on every log() call (see resolveTerminalId
  // below) instead of being snapshotted here, so a caller passing a resolver
  // function (e.g. logger-instance.ts's getTerminalId) picks up a later
  // Settings change without needing a logger recreation/reload.
  const terminalIdInput: TerminalIdInput = context.terminalId ?? 'UNKNOWN';
  const sessionId = context.sessionId || crypto.randomUUID();
  const appVersion = context.appVersion || '0.0.0';
  const userId = context.userId;
  const shiftId = context.shiftId;

  function resolveTerminalId(): string {
    return typeof terminalIdInput === 'function' ? terminalIdInput() : terminalIdInput;
  }

  const fullConfig: LoggerConfig = {
    minLevel: config?.minLevel || (import.meta.env.DEV ? 'debug' : 'info'),
    isDevelopment: config?.isDevelopment ?? import.meta.env.DEV,
    isTauri: config?.isTauri ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window),
    enableRemoteLogging: config?.enableRemoteLogging ?? false,
  };

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[fullConfig.minLevel];
  }

  function log(level: LogLevel, event: string, payload?: SafeLogPayload, raw?: unknown): void {
    if (!shouldLog(level)) {
      return;
    }

    // Validate event name
    validateEventName(event);

    // Create log entry -- context (incl. terminalId) is built fresh per call.
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      context: {
        terminalId: resolveTerminalId(),
        sessionId,
        appVersion,
        ...(userId !== undefined && { userId }),
        ...(shiftId !== undefined && { shiftId }),
      },
      ...(payload !== undefined && { payload }),
    };

    // Add error message if provided
    if (raw) {
      if (raw instanceof Error) {
        entry.error = raw.message;
        // In development, include stack trace
        if (fullConfig.isDevelopment && raw.stack) {
          entry.payload = {
            ...entry.payload,
            stack: raw.stack,
          };
        }
      } else if (typeof raw === 'string') {
        entry.error = raw;
      } else {
        entry.error = 'Unknown error';
      }
    }

    // Send to transports
    consoleTransport(entry, fullConfig.isDevelopment);

    if (fullConfig.isTauri && !fullConfig.isDevelopment) {
      tauriTransport(entry).catch((error: unknown) => {
        console.error('Failed to write log to Tauri:', error);
      });
    }

    if (fullConfig.enableRemoteLogging && !fullConfig.isDevelopment) {
      remoteTransport(entry);
    }
  }

  return {
    debug(event: string, payload?: SafeLogPayload): void {
      log('debug', event, payload);
    },

    info(event: string, payload?: SafeLogPayload): void {
      log('info', event, payload);
    },

    warn(event: string, payload?: SafeLogPayload): void {
      log('warn', event, payload);
    },

    error(event: string, payload?: SafeLogPayload, raw?: unknown): void {
      log('error', event, payload, raw);
    },

    child(additionalContext: LoggerContextInput): Logger {
      const childUserId = additionalContext.userId ?? userId;
      const childShiftId = additionalContext.shiftId ?? shiftId;
      return createLogger(
        {
          terminalId: additionalContext.terminalId ?? terminalIdInput,
          sessionId,
          appVersion,
          ...(childUserId !== undefined && { userId: childUserId }),
          ...(childShiftId !== undefined && { shiftId: childShiftId }),
        },
        fullConfig
      );
    },
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Sanitizes a payload to remove any potential PII.
 *
 * Use this when logging data from external sources that might contain PII.
 *
 * @param payload - Payload to sanitize
 * @returns Sanitized payload
 *
 * @example
 * ```typescript
 * const sanitized = sanitizePayload(userInput)
 * logger.info('user.action', sanitized)
 * ```
 */
export function sanitizePayload(payload: Record<string, unknown>): SafeLogPayload {
  const bannedKeys: BannedKeys[] = [
    'pin',
    'cardNumber',
    'cvv',
    'squareToken',
    'password',
    'rawCard',
    'cardData',
    'paymentToken',
    'securityCode',
    'fullName',
    'referenceNumber',
    'terminalReference',
    'rappiOrderId',
  ];

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (bannedKeys.includes(key as BannedKeys)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizePayload(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Redacts sensitive parts of a string (e.g., card numbers, emails).
 *
 * @param value - String to redact
 * @param type - Type of redaction
 * @returns Redacted string
 *
 * @example
 * ```typescript
 * redactString('4111111111111111', 'card') // "4111********1111"
 * redactString('user@example.com', 'email') // "u***@example.com"
 * ```
 */
export function redactString(value: string, type: 'card' | 'email' | 'phone'): string {
  switch (type) {
    case 'card': {
      // Show first 4 and last 4 digits
      if (value.length >= 8) {
        return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
      }
      return '*'.repeat(value.length);
    }

    case 'email': {
      // Show first char and domain
      const [local, domain] = value.split('@');
      if (local && domain) {
        const firstChar = local[0] ?? '';
        return `${firstChar}***@${domain}`;
      }
      return '***@***';
    }

    case 'phone': {
      // Show last 4 digits
      if (value.length >= 4) {
        return `***-***-${value.slice(-4)}`;
      }
      return '***-***-****';
    }

    default:
      return '***';
  }
}

export const logger = createLogger({});
