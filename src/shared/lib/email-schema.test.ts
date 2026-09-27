import { describe, expect, it } from 'vitest';
import { ReceiptEmailSchema } from './email-schema';

describe('ReceiptEmailSchema', () => {
  it('accepts valid email', () => {
    const r = ReceiptEmailSchema.safeParse('guest@example.com');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toBe('guest@example.com');
    }
  });

  it('trims surrounding whitespace', () => {
    const r = ReceiptEmailSchema.safeParse('  user@domain.co  ');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toBe('user@domain.co');
    }
  });

  it('rejects invalid email with message', () => {
    const r = ReceiptEmailSchema.safeParse('not-an-email');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toContain('valid');
    }
  });
});
