import { canSubmitPin, errorAfterTyping } from './login-guards';

const ok = { hasSelection: true, pin: '123456', lockedUntil: null, busy: false };

describe('canSubmitPin', () => {
  it('is true only for a selected user, 6 digits, not locked, not busy', () => {
    expect(canSubmitPin(ok)).toBe(true);
  });
  it('is false while busy', () => {
    expect(canSubmitPin({ ...ok, busy: true })).toBe(false);
  });
  it('is false while locked', () => {
    expect(canSubmitPin({ ...ok, lockedUntil: Date.now() + 1000 })).toBe(false);
  });
  it('is false for 5 digits', () => {
    expect(canSubmitPin({ ...ok, pin: '12345' })).toBe(false);
  });
  it('is false without a selection', () => {
    expect(canSubmitPin({ ...ok, hasSelection: false })).toBe(false);
  });
});

describe('errorAfterTyping', () => {
  it('keeps the lock message while locked', () => {
    expect(errorAfterTyping('Too many attempts.', Date.now() + 1000)).toBe('Too many attempts.');
  });
  it('clears the error when not locked', () => {
    expect(errorAfterTyping('Wrong PIN.', null)).toBeNull();
  });
});
