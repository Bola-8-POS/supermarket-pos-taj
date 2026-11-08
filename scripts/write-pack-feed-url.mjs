// Writes src-tauri/posctl/pack-feed-url.txt, the build-time resource that tells posctl where to look for pack-latest.json.
// Same idea as src-tauri/cert/subject.txt: derived at build from the customer's override, never committed.
//   node scripts/write-pack-feed-url.mjs --override customers/<name>/tauri.override.json
//   node scripts/write-pack-feed-url.mjs --dev        (a URL that cannot resolve, plus an empty backend.pospack, for CI and local builds)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DEST = join(ROOT, 'src-tauri', 'posctl', 'pack-feed-url.txt');
export const DEFAULT_PACK_DEST = join(ROOT, 'src-tauri', 'posctl', 'backend.pospack');
export const DEV_FEED_URL = 'https://pack-feed.invalid/pack-latest.json';

export function feedUrlFromOverride(override) {
  const endpoint = override?.plugins?.updater?.endpoints?.[0];
  if (typeof endpoint !== 'string' || !endpoint.endsWith('/latest.json')) throw new Error('the override has no updater endpoint ending in /latest.json');
  if (!endpoint.startsWith('https://')) throw new Error('the updater endpoint must be https');
  return `${endpoint.slice(0, -'latest.json'.length)}pack-latest.json`;
}

export function writeFeedUrl(url, dest = DEFAULT_DEST) {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, url);
}

/** Dev/CI only: a 0-byte placeholder so bundle.resources resolves. Plan 05b treats size 0 as "no bundled pack". A real pack is never overwritten. */
export function writeDevPlaceholderPack(dest = DEFAULT_PACK_DEST) {
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, '');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; // the repo's pattern (scripts/check-secrets.mjs)
if (isMain) {
  const { values } = parseArgs({ options: { override: { type: 'string' }, dev: { type: 'boolean', default: false }, dest: { type: 'string' } } });
  try {
    const url = values.dev ? DEV_FEED_URL : feedUrlFromOverride(JSON.parse(readFileSync(values.override ?? '', 'utf8')));
    writeFeedUrl(url, values.dest ?? DEFAULT_DEST);
    if (values.dev) writeDevPlaceholderPack();
    console.log(`wrote ${values.dest ?? DEFAULT_DEST}`);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    process.exit(1);
  }
}
