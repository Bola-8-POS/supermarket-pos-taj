/**
 * Pins the desktop shell's security-relevant configuration: the CSPs both
 * `tauri.conf.json` and `firebase.json` ship, the two per-window
 * capability files, the application-command manifest in `build.rs`/
 * `lib.rs`, and the installer hooks file. Reads the real files with
 * `node:fs` relative to `process.cwd()` (the repo root, however the test
 * runner is invoked) rather than mocking any of them, so a change to one
 * file that forgets its counterpart fails here instead of at build time.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_CSP, DESKTOP_DEV_CSP, isAllowedBackendUrl, SUPABASE_HOSTS, WEB_CSP } from '../../../../scripts/csp';

const ROOT = process.cwd();

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

function connectSrcDirectives(csp: string): string[] {
  const match = /connect-src ([^;]*)/.exec(csp);
  return match ? match[1]!.trim().split(/\s+/) : [];
}

describe('tauri.conf.json security block', () => {
  const conf = readJson('src-tauri/tauri.conf.json') as {
    app: { security: Record<string, unknown> };
  };

  it('app.security.csp equals DESKTOP_CSP', () => {
    expect(conf.app.security['csp'], 'src-tauri/tauri.conf.json app.security.csp').toBe(DESKTOP_CSP);
  });

  it('app.security.devCsp equals DESKTOP_DEV_CSP', () => {
    expect(conf.app.security['devCsp'], 'src-tauri/tauri.conf.json app.security.devCsp').toBe(
      DESKTOP_DEV_CSP
    );
  });

  it('app.security.dangerousDisableAssetCspModification is exactly ["style-src"]', () => {
    expect(
      conf.app.security['dangerousDisableAssetCspModification'],
      'src-tauri/tauri.conf.json app.security.dangerousDisableAssetCspModification'
    ).toEqual(['style-src']);
  });
});

describe('firebase.json CSP header', () => {
  const fb = readJson('firebase.json') as {
    hosting: { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
  };

  it('carries WEB_CSP as Content-Security-Policy on "**"', () => {
    const block = fb.hosting.headers.find((h) => h.source === '**');
    expect(block, 'firebase.json hosting.headers entry for source "**"').toBeTruthy();
    const cspHeader = block?.headers.find((h) => h.key === 'Content-Security-Policy');
    expect(cspHeader?.value, 'firebase.json "**" Content-Security-Policy header value').toBe(WEB_CSP);
  });
});

describe.each([
  ['DESKTOP_CSP', DESKTOP_CSP],
  ['WEB_CSP', WEB_CSP],
])('%s baseline hardening', (name, csp) => {
  it(`${name} contains object-src 'none'`, () => {
    expect(csp, name).toContain("object-src 'none'");
  });

  it(`${name} contains frame-src 'none'`, () => {
    expect(csp, name).toContain("frame-src 'none'");
  });

  it(`${name} connect-src https: entries are all allow-listed`, () => {
    const httpsEntries = connectSrcDirectives(csp).filter((d) => d.startsWith('https:'));
    for (const entry of httpsEntries) {
      expect(SUPABASE_HOSTS as readonly string[], `${name} connect-src entry ${entry}`).toContain(entry);
    }
  });

  it(`${name} has no bare wildcard origin token`, () => {
    const tokens = csp.split(';').flatMap((d) => d.trim().split(/\s+/));
    expect(tokens, name).not.toContain('*');
  });

  it(`${name} never contains the exact 'unsafe-eval' token`, () => {
    const tokens = csp.split(/[\s;]+/);
    expect(tokens, name).not.toContain("'unsafe-eval'");
  });

  it(`${name} allows 'unsafe-inline' only in style-src`, () => {
    for (const directive of csp.split(';').map((d) => d.trim())) {
      if (directive.includes("'unsafe-inline'")) {
        expect(directive.startsWith('style-src'), `${name} directive carrying 'unsafe-inline': ${directive}`).toBe(
          true
        );
      }
    }
  });

  it(`${name} contains 'wasm-unsafe-eval' (required by yoga-layout/@react-pdf)`, () => {
    expect(csp, name).toContain("'wasm-unsafe-eval'");
  });
});

describe('WEB_CSP excludes desktop-only origins', () => {
  it('has no ipc: scheme', () => {
    expect(WEB_CSP, 'WEB_CSP').not.toContain('ipc:');
  });

  it('has no localhost entry', () => {
    expect(WEB_CSP, 'WEB_CSP').not.toContain('localhost');
  });

  it('has no 127.0.0.1 entry', () => {
    expect(WEB_CSP, 'WEB_CSP').not.toContain('127.0.0.1');
  });
});

describe('isAllowedBackendUrl (the web build-time host guard, and the TS twin of is_allowed_backend_url)', () => {
  it.each([
    ['https://abc.supabase.co', true],
    ['http://127.0.0.1:54321', true],
    ['https://evil.example', false],
    ['https://x.supabase.co.other.example', false],
    ['https://x.supabase.co@evil.example/', false],
    ['http://abc.supabase.co', false],
  ] as const)('isAllowedBackendUrl(%s) === %s', (url, expected) => {
    expect(isAllowedBackendUrl(url), `isAllowedBackendUrl(${url})`).toBe(expected);
  });
});

type PermissionEntry = string | { identifier: string };

function permissionIds(permissions: PermissionEntry[]): string[] {
  return permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
}

function parseBuildRsCommands(): string[] {
  const text = readText('src-tauri/build.rs');
  const match = /\.commands\(&\[([\s\S]*?)\]\)/.exec(text);
  expect(match, 'src-tauri/build.rs .commands(&[...]) array').toBeTruthy();
  return Array.from(match![1]!.matchAll(/"([a-zA-Z0-9_]+)"/g)).map((m) => m[1]!);
}

describe('capability files', () => {
  it('src-tauri/capabilities contains exactly main.json and peek.json', () => {
    const files = readdirSync(join(ROOT, 'src-tauri/capabilities')).sort();
    expect(files, 'src-tauri/capabilities directory listing').toEqual(['main.json', 'peek.json']);
  });

  const main = readJson('src-tauri/capabilities/main.json') as { permissions: PermissionEntry[] };
  const peek = readJson('src-tauri/capabilities/peek.json') as { permissions: PermissionEntry[] };
  const mainIds = permissionIds(main.permissions);
  const peekIds = permissionIds(peek.permissions);

  it('peek.json grants no fs:/dialog:/opener:/updater:/process:/notification: permission', () => {
    const forbiddenPrefixes = ['fs:', 'dialog:', 'opener:', 'updater:', 'process:', 'notification:'];
    for (const id of peekIds) {
      expect(
        forbiddenPrefixes.some((prefix) => id.startsWith(prefix)),
        `src-tauri/capabilities/peek.json permission ${id}`
      ).toBe(false);
    }
  });

  it('peek.json does not grant core:webview:allow-create-webview-window', () => {
    expect(peekIds, 'src-tauri/capabilities/peek.json permissions').not.toContain(
      'core:webview:allow-create-webview-window'
    );
  });

  it('peek.json grants exactly the two application commands allow-get-runtime-config and allow-write-log', () => {
    const appCommandIds = peekIds.filter((id) => id.startsWith('allow-')).sort();
    expect(appCommandIds, 'src-tauri/capabilities/peek.json application-command permissions').toEqual([
      'allow-get-runtime-config',
      'allow-write-log',
    ]);
  });

  it('main.json grants allow-<cmd> for exactly the nine build.rs commands', () => {
    const commands = parseBuildRsCommands();
    expect(commands.length, 'src-tauri/build.rs command count').toBe(9);
    const expectedIds = commands.map((c) => `allow-${c.replace(/_/g, '-')}`).sort();
    const appCommandIds = mainIds.filter((id) => id.startsWith('allow-')).sort();
    expect(appCommandIds, 'src-tauri/capabilities/main.json application-command permissions').toEqual(
      expectedIds
    );
  });

  it('the build.rs commands equal lib.rs generate_handler! commands', () => {
    const commands = parseBuildRsCommands();
    const libText = readText('src-tauri/src/lib.rs');
    const handlerMatch = /generate_handler!\[([\s\S]*?)\]/.exec(libText);
    expect(handlerMatch, 'src-tauri/src/lib.rs generate_handler![...] block').toBeTruthy();
    const handlerCommands = handlerMatch![1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(handlerCommands.sort(), 'src-tauri/src/lib.rs generate_handler! commands').toEqual(
      [...commands].sort()
    );
  });

  it('opener:default appears in neither capability file', () => {
    expect(mainIds, 'src-tauri/capabilities/main.json permissions').not.toContain('opener:default');
    expect(peekIds, 'src-tauri/capabilities/peek.json permissions').not.toContain('opener:default');
  });
});

describe('windows/hooks.nsh', () => {
  const text = readText('windows/hooks.nsh');

  function section(macroName: string): string {
    const re = new RegExp(`!macro ${macroName}[\\s\\S]*?!macroend`);
    const match = re.exec(text);
    expect(match, `windows/hooks.nsh !macro ${macroName} ... !macroend block`).toBeTruthy();
    return match![0];
  }

  it('defines all four NSIS_HOOK macros', () => {
    for (const name of [
      'NSIS_HOOK_PREINSTALL',
      'NSIS_HOOK_POSTINSTALL',
      'NSIS_HOOK_PREUNINSTALL',
      'NSIS_HOOK_POSTUNINSTALL',
    ]) {
      expect(text, `windows/hooks.nsh !macro ${name}`).toContain(`!macro ${name}`);
    }
  });

  it('POSTINSTALL reads PROGRAMDATA via ReadEnvStr', () => {
    const post = section('NSIS_HOOK_POSTINSTALL');
    expect(post, 'windows/hooks.nsh POSTINSTALL').toMatch(/ReadEnvStr\s+\$\d+\s+PROGRAMDATA/);
  });

  it('POSTINSTALL sets the data folder ACL with icacls /setowner', () => {
    const post = section('NSIS_HOOK_POSTINSTALL');
    expect(post, 'windows/hooks.nsh POSTINSTALL').toContain('icacls');
    expect(post, 'windows/hooks.nsh POSTINSTALL').toContain('/setowner');
    expect(post, 'windows/hooks.nsh POSTINSTALL').toContain('PrintBroker');
  });

  it('POSTINSTALL deletes the firewall rule before adding it', () => {
    const post = section('NSIS_HOOK_POSTINSTALL');
    const deleteIdx = post.indexOf('netsh advfirewall firewall delete rule name="Store Print Broker"');
    const addIdx = post.indexOf('netsh advfirewall firewall add rule name="Store Print Broker"');
    expect(deleteIdx, 'windows/hooks.nsh POSTINSTALL firewall delete rule').toBeGreaterThanOrEqual(0);
    expect(addIdx, 'windows/hooks.nsh POSTINSTALL firewall add rule').toBeGreaterThan(deleteIdx);
  });

  it('POSTINSTALL removes the root certificate before adding it', () => {
    const post = section('NSIS_HOOK_POSTINSTALL');
    const delstoreIdx = post.indexOf('certutil -delstore Root');
    const addstoreIdx = post.indexOf('certutil -f -addstore Root');
    expect(delstoreIdx, 'windows/hooks.nsh POSTINSTALL certutil -delstore Root').toBeGreaterThanOrEqual(0);
    expect(addstoreIdx, 'windows/hooks.nsh POSTINSTALL certutil -f -addstore Root').toBeGreaterThan(
      delstoreIdx
    );
  });

  it('every ExecWait uses the ExecWait \'...\' $0 form, preceded by ClearErrors, with ${Errors} checked', () => {
    const execWaitLines = (text.match(/^.*ExecWait.*$/gm) ?? []).filter(
      (line) => !line.trim().startsWith(';')
    );
    expect(execWaitLines.length, 'windows/hooks.nsh ExecWait line count').toBeGreaterThan(0);
    for (const line of execWaitLines) {
      expect(line, `windows/hooks.nsh line: ${line}`).toMatch(/ExecWait\s+'[^']*'\s+\$0/);
    }
    expect(text, 'windows/hooks.nsh').toContain('ClearErrors');
    expect(text, 'windows/hooks.nsh').toContain('${Errors}');
  });

  it('WaitBrokerStopped polls sc query via nsExec::ExecToStack and runs after each sc.exe stop', () => {
    const waitMacro = section('WaitBrokerStopped');
    expect(waitMacro, 'windows/hooks.nsh WaitBrokerStopped').toContain('nsExec::ExecToStack');
    expect(waitMacro, 'windows/hooks.nsh WaitBrokerStopped').toContain('sc query PrintBrokerService');

    const pre = section('NSIS_HOOK_PREINSTALL');
    const preUn = section('NSIS_HOOK_PREUNINSTALL');
    for (const [label, blockText] of [
      ['PREINSTALL', pre],
      ['PREUNINSTALL', preUn],
    ] as const) {
      const stopIdx = blockText.indexOf('sc.exe stop PrintBrokerService');
      const waitIdx = blockText.indexOf('WaitBrokerStopped');
      expect(stopIdx, `windows/hooks.nsh ${label} sc.exe stop`).toBeGreaterThanOrEqual(0);
      expect(waitIdx, `windows/hooks.nsh ${label} WaitBrokerStopped call`).toBeGreaterThan(stopIdx);
    }
  });

  it('WaitBrokerStopped wakes a still-running previous-release broker before waiting', () => {
    // The previous release's request loop only checks its shutdown flag when
    // a request arrives, and nothing arrives on its own once the app has
    // exited — so the wait needs to poke it once before polling `sc query`.
    const waitMacro = section('WaitBrokerStopped');
    expect(waitMacro, 'windows/hooks.nsh WaitBrokerStopped').toContain('127.0.0.1:8973');

    const lines = text.split(/\r?\n/);
    const execLineNumbers = lines
      .map((line, i) => ({ line, lineNumber: i + 1 }))
      .filter(
        ({ line }) =>
          /nsExec::Exec\s/.test(line) && !line.includes('ExecToStack') && !line.trim().startsWith(';')
      )
      .map(({ lineNumber }) => lineNumber);
    expect(execLineNumbers.length, 'windows/hooks.nsh nsExec::Exec call count').toBeGreaterThan(0);
    for (const lineNumber of execLineNumbers) {
      const firstAfter = lines[lineNumber]?.trim() ?? '';
      const secondAfter = lines[lineNumber + 1]?.trim() ?? '';
      expect(
        firstAfter,
        `windows/hooks.nsh line ${lineNumber + 1} (Pop after nsExec::Exec on line ${lineNumber})`
      ).toMatch(/^Pop \$\d/);
      expect(
        secondAfter,
        `windows/hooks.nsh line ${lineNumber + 2} (exactly one Pop after nsExec::Exec on line ${lineNumber})`
      ).not.toMatch(/^Pop \$\d/);
    }
  });

  it('each nsExec::ExecToStack call pops both the exit code and the output text', () => {
    // nsExec::ExecToStack pushes two values (output, then exit code on top) —
    // a single Pop only retrieves the exit code and leaves the output
    // string on the stack, corrupting whatever the caller pops next.
    const lines = text.split(/\r?\n/);
    const execToStackLineNumbers = lines
      .map((line, i) => ({ line, lineNumber: i + 1 }))
      .filter(({ line }) => line.includes('nsExec::ExecToStack') && !line.trim().startsWith(';'))
      .map(({ lineNumber }) => lineNumber);
    expect(execToStackLineNumbers.length, 'windows/hooks.nsh nsExec::ExecToStack call count').toBeGreaterThan(0);
    for (const lineNumber of execToStackLineNumbers) {
      const firstPop = lines[lineNumber]?.trim() ?? '';
      const secondPop = lines[lineNumber + 1]?.trim() ?? '';
      expect(firstPop, `windows/hooks.nsh line ${lineNumber + 1} (first Pop after nsExec::ExecToStack on line ${lineNumber})`).toMatch(/^Pop \$\d/);
      expect(secondPop, `windows/hooks.nsh line ${lineNumber + 2} (second Pop after nsExec::ExecToStack on line ${lineNumber})`).toMatch(/^Pop \$\d/);
    }
  });

  it('the MessageBox is guarded by $PassiveMode and ${Silent}', () => {
    const brokerStep = section('BrokerStep');
    expect(brokerStep, 'windows/hooks.nsh BrokerStep').toContain('$PassiveMode');
    expect(brokerStep, 'windows/hooks.nsh BrokerStep').toMatch(/\$\{Silent\}|IfSilent/);
    expect(brokerStep, 'windows/hooks.nsh BrokerStep').toContain('MessageBox');
  });

  it('PREUNINSTALL is guarded by $UpdateMode and cleans up the service, firewall rule and certificate', () => {
    const preUn = section('NSIS_HOOK_PREUNINSTALL');
    expect(preUn, 'windows/hooks.nsh PREUNINSTALL').toContain('$UpdateMode');
    expect(preUn, 'windows/hooks.nsh PREUNINSTALL').toContain('sc.exe stop');
    expect(preUn, 'windows/hooks.nsh PREUNINSTALL').toContain('broker.exe" uninstall');
    expect(preUn, 'windows/hooks.nsh PREUNINSTALL').toContain(
      'netsh advfirewall firewall delete rule name="Store Print Broker"'
    );
    expect(preUn, 'windows/hooks.nsh PREUNINSTALL').toContain('certutil -delstore Root');
  });

  it('every register the file uses has both a Push and a Pop', () => {
    const registers = new Set((text.match(/\$[0-9]/g) ?? []).map((r) => r));
    expect(registers.size, 'windows/hooks.nsh registers referenced').toBeGreaterThan(0);
    for (const reg of registers) {
      expect(text, `windows/hooks.nsh Push ${reg}`).toContain(`Push ${reg}`);
      expect(text, `windows/hooks.nsh Pop ${reg}`).toContain(`Pop ${reg}`);
    }
  });
});

describe('.github/workflows/release.yml cleanup step', () => {
  const text = readText('.github/workflows/release.yml');

  function step(name: string): string {
    const re = new RegExp(`- name: ${name}[\\s\\S]*?(?=\\n      - name:|$)`);
    const match = re.exec(text);
    expect(match, `.github/workflows/release.yml step "${name}"`).toBeTruthy();
    return match![0];
  }

  function guardLineBefore(block: string, needle: string): string {
    const idx = block.indexOf(needle);
    expect(idx, `.github/workflows/release.yml line containing "${needle}"`).toBeGreaterThan(-1);
    return (
      block
        .slice(0, idx)
        .split('\n')
        .filter((l) => l.trim().startsWith('if'))
        .pop() ?? ''
    );
  }

  it('removes the runner-local signing certificate whichever path ran, but only removes the PFX temp file when one was written', () => {
    const cleanup = step('Clean up materialized secrets');
    expect(cleanup, '.github/workflows/release.yml "Clean up materialized secrets"').toContain('if: always()');

    // The certificate outlives signing on both paths (self-signed always
    // mints one; the PFX path also imports one) — a customer's own PC comes
    // to trust it on the next upgrade, so it must not be left behind on the
    // shared runner regardless of which path produced it.
    const certGuard = guardLineBefore(cleanup, 'Cert:\\CurrentUser\\My\\$thumbprint');
    expect(certGuard, '.github/workflows/release.yml certificate removal guard').toContain('$thumbprint');
    expect(certGuard, '.github/workflows/release.yml certificate removal guard').not.toContain('$pfxTempPath');

    // The temp PFX file only ever exists on the PFX path, so its own removal
    // stays conditional on $pfxTempPath.
    const pfxGuard = guardLineBefore(cleanup, 'Remove-Item -LiteralPath $pfxTempPath');
    expect(pfxGuard, '.github/workflows/release.yml PFX temp file removal guard').toContain('$pfxTempPath');
  });
});

describe('agent command removal', () => {
  it('lib.rs does not reference agent_index_status', () => {
    const libText = readText('src-tauri/src/lib.rs');
    expect(libText, 'src-tauri/src/lib.rs').not.toContain('agent_index_status');
  });

  it('src-tauri/src/commands/agent.rs no longer exists', () => {
    expect(existsSync(join(ROOT, 'src-tauri/src/commands/agent.rs')), 'src-tauri/src/commands/agent.rs').toBe(
      false
    );
  });
});
