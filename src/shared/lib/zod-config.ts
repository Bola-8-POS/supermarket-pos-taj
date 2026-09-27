/**
 * Imported first, before anything else in the app touches `zod`: zod 4's
 * default (non-jitless) mode probes `new Function("")` once at startup
 * (`node_modules/zod/v4/core/util.js`) to decide whether it can JIT-compile
 * validators, and a CSP with no `'unsafe-eval'` in `script-src` turns that
 * probe into one logged console error on every load. `jitless: true` skips
 * the probe entirely; zod still validates correctly, just without the JIT
 * fast path. Every zod schema in this app is small enough that the
 * interpreted path costs nothing a user would notice.
 */
import { z } from 'zod';

z.config({ jitless: true });
