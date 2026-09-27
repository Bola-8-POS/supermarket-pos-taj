import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTerminalForNewDemo, startDemoTrial } from '@shared/lib/license/actions';
import type * as ConfigModule from '@shared/lib/license/config';
import type * as StoreModule from '@shared/lib/license/store';
import type { LicenseEvaluation, LicensePayload } from '@shared/lib/license/types';
import { LicenseGate } from './LicenseGate';

const configState = { autoStart: false };
vi.mock('@shared/lib/license/config', async importOriginal => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    isDemoAutoStart: () => configState.autoStart,
  };
});

vi.mock('@shared/lib/license/actions', () => ({
  startDemoTrial: vi.fn(() => new Promise(() => {})),
  resetTerminalForNewDemo: vi.fn(() => new Promise(() => {})),
}));

// Full control over what the gate sees, decoupled from real token verification —
// the reviewer's fix needs to drive locked -> active -> locked(different reason)
// transitions deterministically, which real Zustand + JWT verification can't do cleanly.
let currentEvaluation: LicenseEvaluation = { state: 'locked', reason: 'unlicensed' };
vi.mock('@shared/lib/license/store', async importOriginal => {
  const actual = await importOriginal<typeof StoreModule>();
  return {
    ...actual,
    useLicenseEvaluation: () => currentEvaluation,
    useLicenseStore: (
      selector: (s: { payload: LicensePayload | null; lastError: string | null }) => unknown
    ) => selector({ payload: null, lastError: null }),
  };
});

const demoPayload = (): LicensePayload => ({
  v: 1,
  tenant_id: 't',
  tenant_slug: 'demo-1',
  tenant_name: 'Demo',
  terminal_id: 'term-1',
  plan: 'demo',
  status: 'active',
  period_end: '2026-09-28T00:00:00Z',
  grace_days: 0,
  updates_until: null,
  max_terminals: 1,
  issued_at: '2026-09-14T00:00:00Z',
  lease_until: '2026-09-28T00:00:00Z',
  features: null,
});

const gate = () => (
  <LicenseGate>
    <div>App content</div>
  </LicenseGate>
);

describe('LicenseGate', () => {
  beforeEach(() => {
    configState.autoStart = false;
    currentEvaluation = { state: 'locked', reason: 'unlicensed' };
    vi.mocked(startDemoTrial).mockReset().mockImplementation(() => new Promise(() => {}));
    vi.mocked(resetTerminalForNewDemo).mockReset().mockImplementation(() => new Promise(() => {}));
  });

  it('shows the try-it-free button when locked and auto-start is off', () => {
    render(gate());

    expect(screen.getByTestId('start-demo-button')).toBeInTheDocument();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('auto-starts a demo and shows the preparing spinner when isDemoAutoStart is on', () => {
    configState.autoStart = true;

    render(gate());

    expect(screen.getByTestId('license-gate-preparing')).toBeInTheDocument();
    expect(startDemoTrial).toHaveBeenCalledTimes(1);
  });

  it('recovers to auto-start a fresh demo when the terminal re-locks under a new reason after success', async () => {
    configState.autoStart = true;
    let resolveStart!: (value: Awaited<ReturnType<typeof startDemoTrial>>) => void;
    vi.mocked(startDemoTrial).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveStart = resolve;
        })
    );
    vi.mocked(resetTerminalForNewDemo).mockResolvedValue({ ok: true, data: demoPayload() });

    const { rerender } = render(gate());
    expect(screen.getByTestId('license-gate-preparing')).toBeInTheDocument();

    // Demo provisioning succeeds; the real applyToken()/setLicense() call would flip
    // the store to 'active' before this promise's .then callback ever runs.
    await act(async () => {
      resolveStart({ ok: true, data: demoPayload() });
    });
    currentEvaluation = { state: 'active' };
    rerender(gate());
    expect(screen.getByText('App content')).toBeInTheDocument();

    // 14 days later the demo period ends — the terminal re-locks under a *different* reason.
    currentEvaluation = { state: 'locked', reason: 'demo_expired' };
    rerender(gate());

    expect(resetTerminalForNewDemo).toHaveBeenCalledTimes(1);
  });

  it('does not double-provision a demo under React StrictMode mount double-invoke', () => {
    configState.autoStart = true;

    render(<StrictMode>{gate()}</StrictMode>);

    expect(screen.getByTestId('license-gate-preparing')).toBeInTheDocument();
    expect(startDemoTrial).toHaveBeenCalledTimes(1);
  });
});
