/**
 * Stray control-byte scanner for tracked source text. A `\b` or `\0` that went through a tool which interpreted the escape
 * leaves a literal 0x08 or NUL in the file (a message reading "stateackup.json"). Tab, LF and CR are allowed.
 *
 *   node scripts/check-control-bytes.mjs            scans this git repo (git ls-files)
 *
 * Prints `path:line: control byte 0xNN` per hit and exits 1 on any.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTS = ['.rs', '.ts', '.tsx', '.mjs', '.js', '.ps1', '.json', '.md', '.toml', '.yml', '.sql'];
const SKIPPED = /(^|\/)(__snapshots__|[^/]*-snapshots|fixtures?)\/|\.snap$/;

/** 0x00-0x08, 0x0B, 0x0C and 0x0E-0x1F; 0x09 (tab), 0x0A (LF) and 0x0D (CR) are fine. */
const isBad = (b) => b <= 0x08 || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f);

export function scanBuffer(buf) {
  const hits = [];
  let line = 1;
  for (const b of buf) {
    if (b === 0x0a) line += 1;
    else if (isBad(b)) hits.push({ line, byte: b });
  }
  return hits;
}

export function isScanned(path) {
  return EXTS.some((e) => path.endsWith(e)) && !SKIPPED.test(path);
}

export function scanFiles(root, paths) {
  const out = [];
  for (const p of paths.filter(isScanned)) {
    let buf;
    try {
      buf = readFileSync(join(root, p));
    } catch {
      continue; // listed but deleted in the working tree
    }
    for (const h of scanBuffer(buf)) out.push(`${p}:${h.line}: control byte 0x${h.byte.toString(16).padStart(2, '0')}`);
  }
  return out;
}

export function main(root = ROOT) {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 }).toString('utf8').split('\0').filter(Boolean);
  const findings = scanFiles(root, listed);
  for (const f of findings) console.error(f);
  if (findings.length) console.error(`${findings.length} stray control byte(s)`);
  return findings.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
