/**
 * Repo guard (ASSIST-02, ASSIST-13, D-01/D-03/D-04): the cloud agent-chat is gone and must stay gone, and the
 * renderer never talks to the local model server itself (only the Rust bridge does).
 * Scans every tracked text file in the listed roots; history docs and the secret-scan rules are out of scope.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(process.cwd());
const SELF = 'src/shared/lib/local-assistant/no-cloud-ai.test.ts';

// Directories scanned (plus every tracked file at the repo root).
const SCAN_ROOTS = ['src/', 'e2e/', 'supabase/', 'scripts/', 'store-server/', 'src-tauri/', 'mobile-admin/', '.github/'];

// History and secret-scanner files legitimately name these strings.
const EXEMPT = [
  /^\.planning\//,
  /^docs\//,
  /^HANDOFF\.md$/,
  /^\.agents\//,
  /^scripts\/lib\/secret-rules/,
  /^scripts\/check-secrets\.test\.mjs$/,
  /^scripts\/lib\/secret-scan-allow\.txt$/,
];

const CLOUD_AI: readonly RegExp[] = [
  /agent-proxy/,
  /shared\/lib\/agent/,
  /agent-chat/,
  /agentChat/,
  /api\.anthropic\.com/,
  /ANTHROPIC_API_KEY/,
  /AGENT_ALLOWED_MODELS/,
  /VITE_AGENT_/,
  /VITE_OLLAMA/,
  /callAgentProxy/,
];

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  return out
    .split('\0')
    .filter(Boolean)
    .filter(p => p !== SELF && !EXEMPT.some(re => re.test(p)))
    .filter(p => !p.includes('/') || SCAN_ROOTS.some(root => p.startsWith(root)));
}

/** `path:line` for every line of a tracked text file that matches one of the patterns. */
function hits(files: readonly string[], patterns: readonly RegExp[]): string[] {
  const found: string[] = [];
  for (const path of files) {
    let text: string;
    try {
      text = readFileSync(join(REPO, path), 'utf8');
    } catch {
      continue; // listed in the index but removed from disk, or unreadable
    }
    if (text.includes('\0')) continue; // binary
    text.split('\n').forEach((line, i) => {
      if (patterns.some(re => re.test(line))) found.push(`${path}:${i + 1}`);
    });
  }
  return found;
}

describe('no cloud AI path in the tracked tree', () => {
  const files = trackedFiles();

  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('has no agent-proxy / Anthropic / agent-chat reference', () => {
    expect(hits(files, CLOUD_AI)).toEqual([]);
  });
});

describe('renderer isolation from the local model server (ASSIST-02)', () => {
  const srcFiles = trackedFiles().filter(p => p.startsWith('src/'));

  it('no file under src names the llama-server API or its key', () => {
    expect(hits(srcFiles, [/\/v1\/chat\/completions/, /LLAMA_API_KEY/])).toEqual([]);
  });

  it('local-assistant makes no network call of its own', () => {
    const own = srcFiles.filter(p => p.startsWith('src/shared/lib/local-assistant/'));
    expect(own.length).toBeGreaterThan(5);
    expect(hits(own, [/\bfetch\(/])).toEqual([]);
  });
});
