/**
 * Guard (ASSIST-11, AI-SPEC §4 state management): the assistant reads through the one existing Supabase client,
 * so the same code runs on remote and Docker-local Supabase. No assistant source may pick a backend itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), 'src');
const DIRS = ['shared/lib/local-assistant', 'entities/assistant', 'features/assistant'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    const isTest = /\.(test|integration\.test)\.tsx?$/.test(name);
    return /\.tsx?$/.test(name) && !isTest ? [path] : [];
  });
}

// Anything that selects or configures a backend: runtime config, the store server, a mode flag, a raw env read.
const FORBIDDEN: readonly [string, RegExp][] = [
  ['import of a runtime-config module', /from\s+['"][^'"]*runtime-config[^'"]*['"]/i],
  ['import of a store-server module', /from\s+['"][^'"]*store-server[^'"]*['"]/i],
  ['import of a backend-mode module', /from\s+['"][^'"]*(backend-mode|backendMode|backend_mode)[^'"]*['"]/i],
  ['read of import.meta.env.VITE_SUPABASE', /import\.meta\.env\.VITE_SUPABASE/],
  ['read of import.meta.env.VITE_BACKEND', /import\.meta\.env\.VITE_BACKEND/],
];

describe('assistant modules do not branch on the backend mode', () => {
  const files = DIRS.flatMap(d => sources(join(ROOT, d)));

  it('finds the assistant sources it is meant to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN)('no source has a %s', (_label, re) => {
    const offenders = files.filter(f => re.test(readFileSync(f, 'utf8'))).map(f => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
