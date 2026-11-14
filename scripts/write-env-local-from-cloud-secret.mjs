/**
 * Cursor Cloud / CI helper: materialize bar-pos/.env.local from injected secrets
 * so the dev server sees the same vars as locally, without committing the file.
 *
 * Set ONE of (via Cursor Dashboard → Cloud Agents → Secrets, or CI vars):
 * - BAR_POS_ENV_LOCAL_B64 — base64-encoded full contents of .env.local (recommended).
 * - BAR_POS_ENV_LOCAL — raw multiline contents (only if your secrets backend preserves newlines).
 *
 * If neither is set, exits 0 without creating/updating the file (use Dashboard Secrets
 * for individual VITE_* keys instead — Vite picks those up without a file).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const target = join(dir, '..', '.env.local');

const raw = process.env.BAR_POS_ENV_LOCAL;
const b64 = process.env.BAR_POS_ENV_LOCAL_B64;

if (b64 !== undefined && b64 !== '') {
  writeFileSync(target, Buffer.from(b64, 'base64').toString('utf8'));
  process.stdout.write(`write-env-local-from-cloud-secret: wrote ${target} (from BAR_POS_ENV_LOCAL_B64)\n`);
} else if (raw !== undefined && raw !== '') {
  writeFileSync(target, raw.replace(/\r\n/g, '\n'));
  process.stdout.write(`write-env-local-from-cloud-secret: wrote ${target} (from BAR_POS_ENV_LOCAL)\n`);
} else {
  process.stdout.write(
    'write-env-local-from-cloud-secret: skipped (no BAR_POS_ENV_LOCAL_B64 / BAR_POS_ENV_LOCAL)\n',
  );
}
