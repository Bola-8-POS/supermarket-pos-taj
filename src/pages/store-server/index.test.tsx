import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@shared/lib/i18n';
import { err, ok } from '@shared/lib/result';
import { StoreStatusSchema, type StoreStatus } from '@shared/lib/store-status';
import StoreServerPage from './index';

let offline = true;
let result: ReturnType<typeof ok<StoreStatus>> | ReturnType<typeof err> | undefined;
const refetch = vi.fn();
const openConsole = vi.fn();

vi.mock('@entities/store-status', () => ({
  useStoreStatus: () => ({ data: result, isPending: result === undefined, refetch }),
}));
vi.mock('@shared/lib/store-mode', () => ({ isOfflineOnly: () => offline }));
vi.mock('@shared/lib/posctl-console', () => ({ openPosctlConsole: (a: string) => openConsole(a) }));

const status = (o: object): StoreStatus =>
  StoreStatusSchema.parse({
    schema: 1,
    generatedAt: new Date().toISOString(),
    state: 'running',
    packVersion: '1.2.3',
    services: { postgres: { state: 'running', healthy: true } },
    database: { applied: 4, expected: { applied: 4 } },
    network: { profile: 'Private' },
    ...o,
  });

beforeEach(() => {
  offline = true;
  result = undefined;
  openConsole.mockReset();
  refetch.mockReset();
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
});
afterEach(async () => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  await i18n.changeLanguage('en-US');
});

describe('StoreServerPage', () => {
  it('cloud till: says it uses the cloud and offers set up and join', () => {
    offline = false;
    render(<StoreServerPage />);
    expect(screen.getByTestId('store-server-cloud')).toBeInTheDocument();
    expect(screen.getByTestId('store-server-action-SetUpServer')).toBeInTheDocument();
    expect(screen.getByTestId('store-server-action-JoinServer')).toBeInTheDocument();
    expect(screen.queryByTestId('store-server-action-AddTill')).toBeNull();
  });

  it('healthy store: services, database, pack, network, add till and recovery key', () => {
    result = ok(status({}));
    render(<StoreServerPage />);
    expect(screen.getByTestId('store-server-summary')).toHaveTextContent('Everything is running');
    expect(screen.getByText('Level 4 of 4')).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(screen.getByTestId('store-server-action-AddTill')).toBeInTheDocument();
    expect(screen.getByTestId('store-server-action-ShowRecoveryKey')).toBeInTheDocument();
    expect(screen.queryByTestId('store-server-action-ResumeSetup')).toBeNull();
  });

  it('critical store: shows the alert with its catalog action and a generic line for an unknown code', () => {
    result = ok(
      status({
        alerts: [
          { code: 'BACKUP_KEY_NOT_EXPORTED', level: 'warn', since: null },
          { code: 'FROM_A_LATER_PLAN', level: 'critical', since: null },
        ],
      })
    );
    render(<StoreServerPage />);
    expect(screen.getByTestId('store-server-summary')).toHaveTextContent('Needs attention');
    expect(screen.getByTestId('store-server-alert-FROM_A_LATER_PLAN')).toHaveTextContent(
      'FROM_A_LATER_PLAN'
    );
    expect(screen.getAllByTestId('store-server-action-ShowRecoveryKey').length).toBeGreaterThan(1);
  });

  it('unfinished setup offers ResumeSetup', () => {
    result = ok(status({ state: 'provisioning' }));
    render(<StoreServerPage />);
    expect(screen.getByTestId('store-server-action-ResumeSetup')).toBeInTheDocument();
  });

  it('unreachable server shows the message', () => {
    result = err({ code: 'NETWORK_OFFLINE', message: 'x' });
    render(<StoreServerPage />);
    expect(screen.getByTestId('store-server-unreachable')).toBeInTheDocument();
  });

  it('a button invokes the launcher with its action and shows the outcome', async () => {
    result = ok(status({}));
    openConsole.mockResolvedValue(ok('Declined'));
    render(<StoreServerPage />);
    fireEvent.click(screen.getByTestId('store-server-action-AddTill'));
    expect(openConsole).toHaveBeenCalledWith('AddTill');
    await waitFor(() => {
      expect(screen.getByTestId('store-server-outcome')).toHaveAttribute(
        'data-outcome',
        'Declined'
      );
    });
  });

  it('offers a restart after a launched join', async () => {
    offline = false;
    openConsole.mockResolvedValue(ok('Launched'));
    render(<StoreServerPage />);
    fireEvent.click(screen.getByTestId('store-server-action-JoinServer'));
    expect(await screen.findByText('Restart app')).toBeInTheDocument();
  });
});
