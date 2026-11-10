import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '@shared/lib/zod-config';

describe('zod jitless config', () => {
  it('sets jitless mode so zod never probes new Function() under a strict CSP', () => {
    expect(z.config().jitless).toBe(true);
  });
});
