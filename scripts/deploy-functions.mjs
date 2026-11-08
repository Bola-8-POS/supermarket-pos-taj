// Deploy Supabase edge functions with server-side bundling (--use-api).
// Why --use-api: avoids the local-Docker vs host esm.sh tslib hash difference. Do NOT regenerate the tslib lock hash.
// Usage: node scripts/deploy-functions.mjs --project-ref <ref> [--functions a,b] [--dry-run] [--i-have-owner-go]
// Protected refs (our prod, customer prod) are refused without --i-have-owner-go (owner's go is required first).
// ponytail: no live-source backup or 401 smoke test yet; add when a real deploy is scripted end to end.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTECTED_REFS = {
  xmjpnhowadqgewuxpqva: 'our cloud production',
  mkvinyekkyennyegfoxq: 'customer production (Taj House of Spice)',
};

/** Returns an error string if deploying to `ref` is not allowed, else null. */
export function checkRef(ref, ownerGo) {
  if (!ref || !/^[a-z0-9]{20}$/.test(ref)) return 'invalid or missing --project-ref (expect 20 lowercase alphanumerics)';
  const label = PROTECTED_REFS[ref];
  if (label && !ownerGo) return `refusing ${ref} (${label}) without --i-have-owner-go`;
  return null;
}

export function listFunctions(root) {
  const dir = join(root, 'supabase', 'functions');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && existsSync(join(dir, e.name, 'index.ts')))
    .map((e) => e.name)
    .sort();
}

export function parseArgs(argv) {
  const o = { ref: '', functions: null, dryRun: false, ownerGo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-ref') o.ref = argv[++i] ?? '';
    else if (a === '--functions') o.functions = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--i-have-owner-go') o.ownerGo = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

export function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const o = parseArgs(argv);
  const err = checkRef(o.ref, o.ownerGo);
  if (err) { console.error(err); return 1; }
  const all = listFunctions(root);
  const names = o.functions ?? all;
  const unknown = names.filter((n) => !all.includes(n));
  if (unknown.length) { console.error(`unknown functions: ${unknown.join(', ')}`); return 1; }
  const cmds = names.map((n) => ['supabase', 'functions', 'deploy', n, '--project-ref', o.ref, '--use-api']);
  console.log(`${o.dryRun ? 'DRY RUN, plan' : 'Deploying'} to ${o.ref}: ${names.length} functions`);
  for (const c of cmds) console.log(`  ${c.join(' ')}`);
  if (o.dryRun) return 0;
  for (const [bin, ...args] of cmds) {
    const r = spawnSync(bin, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) { console.error(`deploy failed: ${args[2]}`); return 1; }
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
