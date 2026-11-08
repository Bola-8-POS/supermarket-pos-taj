export function canSubmitPin(args: {
  hasSelection: boolean;
  pin: string;
  lockedUntil: number | null;
  busy: boolean;
}): boolean {
  return args.hasSelection && args.pin.length === 6 && args.lockedUntil === null && !args.busy;
}

/** Typing clears a stale error, but never the lock reason while the button is still locked. */
export function errorAfterTyping(currentError: string | null, lockedUntil: number | null): string | null {
  return lockedUntil !== null ? currentError : null;
}
