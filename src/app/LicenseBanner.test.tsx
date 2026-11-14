import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type * as StoreModule from '@shared/lib/license/store';
import type { LicenseEvaluation } from '@shared/lib/license/types';
import { LicenseBanner } from './LicenseBanner';

let evaluation: LicenseEvaluation = { state: 'active' };
vi.mock('@shared/lib/license/store', async importOriginal => ({
  ...(await importOriginal<typeof StoreModule>()),
  useLicenseEvaluation: () => evaluation,
}));

describe('LicenseBanner', () => {
  it.each(['lease_expired', 'subscription_expired', 'offline_budget_spent'] as const)(
    'names what is refused and what still works when restricted for %s',
    reason => {
      evaluation = { state: 'restricted', reason };
      render(<LicenseBanner />);
      const banner = screen.getByTestId('license-banner');
      expect(banner).toHaveAttribute('data-state', 'restricted');
      expect(banner).toHaveAttribute('data-reason', reason);
      expect(banner).toHaveTextContent(/sales, refunds and receiving are paused/i);
      expect(banner).toHaveTextContent(/close the register/i);
    }
  );

  it.each(['lease_expired', 'offline_budget_spent'] as const)(
    'tells an offline-token store how to recover from %s, not only to connect',
    reason => {
      evaluation = { state: 'restricted', reason };
      render(<LicenseBanner />);
      expect(screen.getByTestId('license-banner')).toHaveTextContent(/paste a new offline token/i);
    }
  );

  it('warns that sales pause on reconnection once half the offline budget is used', () => {
    evaluation = { state: 'warning', kind: 'offline_budget', daysLeft: 12 };
    render(<LicenseBanner />);
    expect(screen.getByTestId('license-banner')).toHaveTextContent(/12 days/);
    expect(screen.getByTestId('license-banner')).toHaveTextContent(/sales pause until the license is verified/i);
  });

  it('renders nothing for a hard lock, which the gate owns', () => {
    evaluation = { state: 'locked', reason: 'unlicensed' };
    render(<LicenseBanner />);
    expect(screen.queryByTestId('license-banner')).not.toBeInTheDocument();
  });
});
