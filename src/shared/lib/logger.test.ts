/**
 * LOGGER TESTS
 *
 * Tests for the structured, PII-safe logger.
 */

/* eslint-disable @typescript-eslint/unbound-method */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, sanitizePayload, redactString } from './logger';

describe('Logger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('createLogger', () => {
    it('creates a logger with context', () => {
      const logger = createLogger({
        terminalId: 'POS-1',
        sessionId: 'test-session',
        appVersion: '1.0.0',
      });

      expect(logger).toBeDefined();
      expect(logger.debug).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(logger.child).toBeDefined();
    });

    it('logs debug messages in development', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true, minLevel: 'debug' }
      );

      logger.debug('test.debug', { foo: 'bar' });

      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('suppresses debug messages in production', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: false, minLevel: 'info' }
      );

      logger.debug('test.debug', { foo: 'bar' });

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('logs info messages', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true }
      );

      logger.info('test.info', { foo: 'bar' });

      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('logs warn messages', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true }
      );

      logger.warn('test.warn', { foo: 'bar' });

      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('logs error messages with error object', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true }
      );

      const error = new Error('Test error');
      logger.error('test.error', { foo: 'bar' }, error);

      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('creates child logger with additional context', () => {
      const logger = createLogger({
        terminalId: 'POS-1',
        sessionId: 'test-session',
        appVersion: '1.0.0',
      });

      const childLogger = logger.child({ userId: 'user-123' });

      expect(childLogger).toBeDefined();
      expect(childLogger.debug).toBeDefined();
    });
  });

  describe('Log level filtering', () => {
    it('respects minLevel configuration', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true, minLevel: 'warn' }
      );

      logger.debug('test.debug');
      logger.info('test.info');
      logger.warn('test.warn');
      logger.error('test.error');

      // Only warn and error should be logged
      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    });

    it('logs all levels when minLevel is debug', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true, minLevel: 'debug' }
      );

      logger.debug('test.debug');
      logger.info('test.info');
      logger.warn('test.warn');
      logger.error('test.error');

      expect(consoleLogSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe('Event name validation', () => {
    it('warns when event name is not namespaced', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true }
      );

      logger.info('notnamespaced');

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('not namespaced'));
    });

    it('does not warn when event name is properly namespaced', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true }
      );

      logger.info('tab.opened');

      // Should only have one console.log call (the actual log), no warnings
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('PII Guard (TypeScript)', () => {
    it('should prevent logging banned keys at compile time', () => {
      const logger = createLogger({
        terminalId: 'POS-1',
        sessionId: 'test-session',
        appVersion: '1.0.0',
      });

      // Note: These would cause TypeScript errors in real code due to SafeLogPayload type
      // The type system prevents banned keys from being logged
      // In tests, we verify the type system works by checking sanitizePayload instead

      // These should be allowed
      logger.info('test', { tabId: '123', amount: 50.0 });
      logger.info('test', { userId: 'user-123', action: 'opened' });

      // Verify that sanitizePayload properly redacts banned keys
      const unsafePayload = {
        tabId: '123',
        pin: '1234',
        cardNumber: '4111111111111111',
      };
      const sanitized = sanitizePayload(unsafePayload);
      expect(sanitized.pin).toBe('[REDACTED]');
      expect(sanitized.cardNumber).toBe('[REDACTED]');
    });
  });

  describe('Error handling', () => {
    it('includes error message in log entry', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true }
      );

      const error = new Error('Test error message');
      logger.error('test.error', {}, error);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Test error message'));
    });

    it('includes stack trace in development', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true }
      );

      const error = new Error('Test error');
      logger.error('test.error', {}, error);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('stack'));
    });

    it('handles non-Error objects', () => {
      const logger = createLogger(
        {
          terminalId: 'POS-1',
          sessionId: 'test-session',
          appVersion: '1.0.0',
        },
        { isDevelopment: true }
      );

      logger.error('test.error', {}, 'String error');

      expect(consoleLogSpy).toHaveBeenCalled();
    });
  });
});

describe('Lazy terminalId resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('accepts a terminalId resolver function and re-invokes it on every log call, not just at creation', async () => {
    vi.useFakeTimers();
    let current = 'POS-A';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const logger = createLogger(
      { terminalId: () => current, sessionId: 'test-session', appVersion: '1.0.0' },
      { isDevelopment: false, enableRemoteLogging: true, minLevel: 'info' }
    );

    logger.info('test.one');
    current = 'POS-B';
    logger.info('test.two');

    await vi.advanceTimersByTimeAsync(10000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      logs: Array<{ context: { terminalId: string } }>;
    };
    expect(body.logs[0]?.context.terminalId).toBe('POS-A');
    expect(body.logs[1]?.context.terminalId).toBe('POS-B');
  });

  it('child() preserves the parent resolver when the child does not override terminalId', async () => {
    vi.useFakeTimers();
    let current = 'POS-X';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const parent = createLogger(
      { terminalId: () => current, sessionId: 'test-session', appVersion: '1.0.0' },
      { isDevelopment: false, enableRemoteLogging: true, minLevel: 'info' }
    );
    const child = parent.child({ userId: 'user-123' });

    current = 'POS-Y';
    child.info('test.child');

    await vi.advanceTimersByTimeAsync(10000);

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      logs: Array<{ context: { terminalId: string; userId?: string } }>;
    };
    expect(body.logs[0]?.context.terminalId).toBe('POS-Y');
    expect(body.logs[0]?.context.userId).toBe('user-123');
  });
});

describe('sanitizePayload', () => {
  it('redacts banned keys', () => {
    const payload = {
      tabId: '123',
      pin: '1234',
      cardNumber: '4111111111111111',
      amount: 50.0,
    };

    const sanitized = sanitizePayload(payload);

    expect(sanitized.tabId).toBe('123');
    expect(sanitized.pin).toBe('[REDACTED]');
    expect(sanitized.cardNumber).toBe('[REDACTED]');
    expect(sanitized.amount).toBe(50.0);
  });

  it('recursively sanitizes nested objects', () => {
    const payload = {
      user: {
        id: '123',
        pin: '1234',
      },
      payment: {
        amount: 50.0,
        cardNumber: '4111111111111111',
      },
    };

    const sanitized = sanitizePayload(payload);

    expect((sanitized.user as Record<string, unknown>).id).toBe('123');
    expect((sanitized.user as Record<string, unknown>).pin).toBe('[REDACTED]');
    expect((sanitized.payment as Record<string, unknown>).amount).toBe(50.0);
    expect((sanitized.payment as Record<string, unknown>).cardNumber).toBe('[REDACTED]');
  });

  it('preserves arrays', () => {
    const payload = {
      items: [{ id: '1' }, { id: '2' }],
    };

    const sanitized = sanitizePayload(payload);

    expect(Array.isArray(sanitized.items)).toBe(true);
    expect(sanitized.items).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('handles null and undefined values', () => {
    const payload = {
      foo: null,
      bar: undefined,
    };

    const sanitized = sanitizePayload(payload);

    expect(sanitized.foo).toBeNull();
    expect(sanitized.bar).toBeUndefined();
  });
});

describe('redactString', () => {
  describe('card redaction', () => {
    it('redacts card numbers showing first 4 and last 4', () => {
      const redacted = redactString('4111111111111111', 'card');
      expect(redacted).toBe('4111********1111');
    });

    it('handles short card numbers', () => {
      const redacted = redactString('1234', 'card');
      expect(redacted).toBe('****');
    });

    it('handles very long card numbers', () => {
      const redacted = redactString('41111111111111111111', 'card');
      expect(redacted).toBe('4111************1111');
    });
  });

  describe('email redaction', () => {
    it('redacts email showing first char and domain', () => {
      const redacted = redactString('user@example.com', 'email');
      expect(redacted).toBe('u***@example.com');
    });

    it('handles email without @', () => {
      const redacted = redactString('notanemail', 'email');
      expect(redacted).toBe('***@***');
    });

    it('handles single char local part', () => {
      const redacted = redactString('a@example.com', 'email');
      expect(redacted).toBe('a***@example.com');
    });
  });

  describe('phone redaction', () => {
    it('redacts phone showing last 4 digits', () => {
      const redacted = redactString('1234567890', 'phone');
      expect(redacted).toBe('***-***-7890');
    });

    it('handles short phone numbers', () => {
      const redacted = redactString('123', 'phone');
      expect(redacted).toBe('***-***-****');
    });

    it('handles exactly 4 digits', () => {
      const redacted = redactString('1234', 'phone');
      expect(redacted).toBe('***-***-1234');
    });
  });
});
