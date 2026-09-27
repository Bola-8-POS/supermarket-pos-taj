/**
 * RESULT TYPE TESTS
 *
 * Tests for the core error handling infrastructure.
 */

import type { PostgrestError } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';
import {
  ok,
  err,
  mapResult,
  unwrapResult,
  isOk,
  isErr,
  networkOfflineError,
  authRequiredError,
  authForbiddenError,
  notFoundError,
  validationError,
  duplicateEntryError,
  tabAlreadyClosedError,
  sessionStillRunningError,
  paymentDeclinedError,
  paymentAlreadyProcessedError,
  inventoryNegativeError,
  supabaseError,
  tauriError,
  unknownError,
  parseSupabaseError,
  versionedMutation,
  type Result,
  type AppError,
} from './result';

describe('Result constructors', () => {
  describe('ok()', () => {
    it('creates a successful Result with data', () => {
      const result = ok(42);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe(42);
      }
    });

    it('works with objects', () => {
      const data = { id: '123', name: 'John' };
      const result = ok(data);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual(data);
      }
    });

    it('works with null', () => {
      const result = ok(null);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBeNull();
      }
    });

    it('works with arrays', () => {
      const data = [1, 2, 3];
      const result = ok(data);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual(data);
      }
    });
  });

  describe('err()', () => {
    it('creates a failed Result with error', () => {
      const error: AppError = {
        code: 'NOT_FOUND',
        message: 'User not found',
      };
      const result = err(error);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual(error);
      }
    });

    it('works with string errors', () => {
      const result = err('Something went wrong');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Something went wrong');
      }
    });

    it('works with custom error types', () => {
      type CustomError = { type: 'custom'; details: string };
      const error: CustomError = { type: 'custom', details: 'Custom error' };
      const result = err(error);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual(error);
      }
    });
  });
});

describe('Result utilities', () => {
  describe('mapResult()', () => {
    it('transforms data in ok Result', () => {
      const result = ok(5);
      const doubled = mapResult(result, x => x * 2);

      expect(doubled.ok).toBe(true);
      if (doubled.ok) {
        expect(doubled.data).toBe(10);
      }
    });

    it('transforms objects in ok Result', () => {
      const result = ok({ value: 10 });
      const transformed = mapResult(result, obj => obj.value * 3);

      expect(transformed.ok).toBe(true);
      if (transformed.ok) {
        expect(transformed.data).toBe(30);
      }
    });

    it('passes through error unchanged', () => {
      const error: AppError = { code: 'NOT_FOUND', message: 'Not found' };
      const result: Result<number> = err(error);
      const mapped = mapResult(result, x => x * 2);

      expect(mapped.ok).toBe(false);
      if (!mapped.ok) {
        expect(mapped.error).toEqual(error);
      }
    });

    it('can change the type of data', () => {
      const result = ok(42);
      const stringified = mapResult(result, x => `Number: ${String(x)}`);

      expect(stringified.ok).toBe(true);
      if (stringified.ok) {
        expect(stringified.data).toBe('Number: 42');
      }
    });

    it('can map to complex objects', () => {
      const result = ok('John');
      const user = mapResult(result, name => ({ id: '123', name }));

      expect(user.ok).toBe(true);
      if (user.ok) {
        expect(user.data).toEqual({ id: '123', name: 'John' });
      }
    });
  });

  describe('unwrapResult()', () => {
    it('returns data from ok Result', () => {
      const result = ok(42);
      const value = unwrapResult(result);

      expect(value).toBe(42);
    });

    it('returns object from ok Result', () => {
      const data = { id: '123', name: 'John' };
      const result = ok(data);
      const value = unwrapResult(result);

      expect(value).toEqual(data);
    });

    it('throws on err Result', () => {
      const error: AppError = { code: 'NOT_FOUND', message: 'Not found' };
      const result: Result<number> = err(error);

      expect(() => unwrapResult(result)).toThrow();
    });

    it('throws with error details', () => {
      const error: AppError = { code: 'NOT_FOUND', message: 'User not found' };
      const result: Result<number> = err(error);

      expect(() => unwrapResult(result)).toThrow(/NOT_FOUND/);
    });
  });

  describe('isOk()', () => {
    it('returns true for ok Result', () => {
      const result = ok(42);
      expect(isOk(result)).toBe(true);
    });

    it('returns false for err Result', () => {
      const result: Result<number> = err({ code: 'NOT_FOUND', message: 'Not found' });
      expect(isOk(result)).toBe(false);
    });

    it('narrows type correctly', () => {
      const result: Result<number> = ok(42);
      if (isOk(result)) {
        // TypeScript should know result.data exists
        expect(result.data).toBe(42);
      }
    });
  });

  describe('isErr()', () => {
    it('returns false for ok Result', () => {
      const result = ok(42);
      expect(isErr(result)).toBe(false);
    });

    it('returns true for err Result', () => {
      const result: Result<number> = err({ code: 'NOT_FOUND', message: 'Not found' });
      expect(isErr(result)).toBe(true);
    });

    it('narrows type correctly', () => {
      const result: Result<number> = err({ code: 'NOT_FOUND', message: 'Not found' });
      if (isErr(result)) {
        // TypeScript should know result.error exists
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });
  });
});

describe('Error factory functions', () => {
  describe('networkOfflineError()', () => {
    it('creates network offline error', () => {
      const error = networkOfflineError();

      expect(error.code).toBe('NETWORK_OFFLINE');
      expect(error.message).toContain('offline');
    });
  });

  describe('authRequiredError()', () => {
    it('creates auth required error', () => {
      const error = authRequiredError();

      expect(error.code).toBe('AUTH_REQUIRED');
      expect(error.message).toContain('log in');
    });
  });

  describe('authForbiddenError()', () => {
    it('creates auth forbidden error with role', () => {
      const error = authForbiddenError('manager');

      expect(error.code).toBe('AUTH_FORBIDDEN');
      expect(error.message).toContain('manager');
    });
  });

  describe('notFoundError()', () => {
    it('creates not found error with default resource', () => {
      const error = notFoundError();

      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toContain('not found');
    });

    it('creates not found error with custom resource', () => {
      const error = notFoundError('User');

      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toContain('User');
    });
  });

  describe('validationError()', () => {
    it('creates validation error with field errors', () => {
      const fields = { email: 'Invalid email', password: 'Too short' };
      const error = validationError(fields);

      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toContain('fields');
      expect(error.detail).toContain('email');
      expect(error.detail).toContain('password');
    });
  });

  describe('duplicateEntryError()', () => {
    it('creates duplicate entry error with default field', () => {
      const error = duplicateEntryError();

      expect(error.code).toBe('DUPLICATE_ENTRY');
      expect(error.message).toContain('already exists');
    });

    it('creates duplicate entry error with custom field', () => {
      const error = duplicateEntryError('email');

      expect(error.code).toBe('DUPLICATE_ENTRY');
      expect(error.message).toContain('email');
    });
  });

  describe('tabAlreadyClosedError()', () => {
    it('creates tab already closed error', () => {
      const error = tabAlreadyClosedError();

      expect(error.code).toBe('TAB_ALREADY_CLOSED');
      expect(error.message).toContain('already been closed');
    });
  });

  describe('sessionStillRunningError()', () => {
    it('creates session still running error with table number', () => {
      const error = sessionStillRunningError(5);

      expect(error.code).toBe('SESSION_STILL_RUNNING');
      expect(error.message).toContain('Table #5');
      expect(error.message).toContain('still running');
    });
  });

  describe('paymentDeclinedError()', () => {
    it('creates payment declined error without reason', () => {
      const error = paymentDeclinedError();

      expect(error.code).toBe('PAYMENT_DECLINED');
      expect(error.message).toContain('declined');
    });

    it('creates payment declined error with reason', () => {
      const error = paymentDeclinedError('Insufficient funds');

      expect(error.code).toBe('PAYMENT_DECLINED');
      expect(error.detail).toBe('Insufficient funds');
    });
  });

  describe('paymentAlreadyProcessedError()', () => {
    it('creates payment already processed error', () => {
      const error = paymentAlreadyProcessedError();

      expect(error.code).toBe('PAYMENT_ALREADY_PROCESSED');
      expect(error.message).toContain('already been processed');
    });
  });

  describe('inventoryNegativeError()', () => {
    it('creates inventory negative error with product name', () => {
      const error = inventoryNegativeError('Beer');

      expect(error.code).toBe('INVENTORY_NEGATIVE');
      expect(error.message).toContain('Beer');
      expect(error.message).toContain('out of stock');
    });
  });

  describe('supabaseError()', () => {
    it('creates supabase error with message', () => {
      const error = supabaseError('Database error');

      expect(error.code).toBe('SUPABASE_ERROR');
      expect(error.message).toBe('Database error');
    });

    it('creates supabase error with detail and original error', () => {
      const raw = new Error('Connection failed');
      const error = supabaseError('Database error', 'Connection timeout', raw);

      expect(error.code).toBe('SUPABASE_ERROR');
      expect(error.detail).toBe('Connection timeout');
      expect(error.raw).toBe(raw);
    });
  });

  describe('tauriError()', () => {
    it('creates tauri error with message', () => {
      const error = tauriError('IPC failed');

      expect(error.code).toBe('TAURI_ERROR');
      expect(error.message).toBe('IPC failed');
    });

    it('creates tauri error with original error', () => {
      const raw = new Error('Command failed');
      const error = tauriError('IPC failed', raw);

      expect(error.code).toBe('TAURI_ERROR');
      expect(error.raw).toBe(raw);
    });
  });

  describe('unknownError()', () => {
    it('creates unknown error without original error', () => {
      const error = unknownError();

      expect(error.code).toBe('UNKNOWN_ERROR');
      expect(error.message).toContain('unexpected');
    });

    it('creates unknown error with original error', () => {
      const raw = new Error('Something broke');
      const error = unknownError(raw);

      expect(error.code).toBe('UNKNOWN_ERROR');
      expect(error.raw).toBe(raw);
    });
  });
});

describe('parseSupabaseError()', () => {
  it('parses unique constraint violation (23505)', () => {
    const pgError: PostgrestError = {
      code: '23505',
      message: 'duplicate key value',
      details: 'Key (email)=(test@example.com) already exists.',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const error = parseSupabaseError(pgError);

    expect(error.code).toBe('DUPLICATE_ENTRY');
  });

  it('parses foreign key violation (23503)', () => {
    const pgError: PostgrestError = {
      code: '23503',
      message: 'foreign key violation',
      details: 'Key (user_id)=(123) is not present in table "users".',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const error = parseSupabaseError(pgError);

    expect(error.code).toBe('SUPABASE_ERROR');
    expect(error.message).toContain('Invalid reference');
  });

  it('parses not null violation (23502)', () => {
    const pgError: PostgrestError = {
      code: '23502',
      message: 'null value in column',
      details: 'Failing row contains (123, null, ...).',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const error = parseSupabaseError(pgError);

    expect(error.code).toBe('SUPABASE_ERROR');
    expect(error.message).toContain('Required field');
  });

  it('parses row not found (PGRST116)', () => {
    const pgError: PostgrestError = {
      code: 'PGRST116',
      message: 'The result contains 0 rows',
      details: '',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const error = parseSupabaseError(pgError);

    expect(error.code).toBe('NOT_FOUND');
  });

  it('parses RLS violation (42501)', () => {
    const pgError: PostgrestError = {
      code: '42501',
      message: 'permission denied',
      details: '',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const error = parseSupabaseError(pgError);

    expect(error.code).toBe('AUTH_FORBIDDEN');
  });

  it('parses check constraint violation (23514)', () => {
    const pgError: PostgrestError = {
      code: '23514',
      message: 'check constraint violated',
      details: 'Failing row contains invalid data.',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const error = parseSupabaseError(pgError);

    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('parses unknown error code', () => {
    const pgError: PostgrestError = {
      code: '99999',
      message: 'Unknown database error',
      details: '',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const error = parseSupabaseError(pgError);

    expect(error.code).toBe('SUPABASE_ERROR');
    expect(error.message).toBe('Unknown database error');
  });

  it('handles missing error code', () => {
    const pgError: PostgrestError = {
      code: '',
      message: 'Something went wrong',
      details: '',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const error = parseSupabaseError(pgError);

    expect(error.code).toBe('SUPABASE_ERROR');
  });
});

describe('versionedMutation()', () => {
  it('returns ok(undefined) when the update matches at least one row', async () => {
    const result = await versionedMutation(() =>
      Promise.resolve({ data: [{ id: 'x' }], error: null })
    );

    expect(result.ok).toBe(true);
  });

  it('returns STALE_VERSION when the update matches zero rows (empty array)', async () => {
    const result = await versionedMutation(() => Promise.resolve({ data: [], error: null }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STALE_VERSION');
    }
  });

  it('returns STALE_VERSION when the update returns null data with no error', () => {
    return versionedMutation(() => Promise.resolve({ data: null, error: null })).then(result => {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('STALE_VERSION');
      }
    });
  });

  it('delegates a P0V01 Supabase error to parseSupabaseError (not the row-count branch)', async () => {
    const pgError: PostgrestError = {
      code: 'P0V01',
      message: 'stale version',
      details: '',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const result = await versionedMutation(() =>
      Promise.resolve({ data: null, error: pgError })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STALE_VERSION');
    }
  });

  it('passes through non-version Supabase errors unchanged', async () => {
    const pgError: PostgrestError = {
      code: '23505',
      message: 'duplicate key value',
      details: '',
      hint: '',
      name: 'PostgrestError',
      toJSON: () => ({ name: 'PostgrestError', message: '', details: '', hint: '', code: '' }),
    };
    const result = await versionedMutation(() =>
      Promise.resolve({ data: null, error: pgError })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DUPLICATE_ENTRY');
    }
  });
});
