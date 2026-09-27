/**
 * Unit tests for ClockDriftBanner component.
 *
 * AC-5: Banner renders when isDrifting=true
 * AC-6: Banner renders nothing when isDrifting=false
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as useServerTimeDriftModule from '@shared/lib/useServerTimeDrift';
import { ClockDriftBanner } from './ClockDriftBanner';

vi.mock('@shared/lib/useServerTimeDrift', () => ({
  useServerTimeDrift: vi.fn(),
}));

const mockedUseServerTimeDrift = vi.mocked(useServerTimeDriftModule.useServerTimeDrift);

describe('ClockDriftBanner', () => {
  it('renders amber banner when isDrifting=true (AC-5)', () => {
    mockedUseServerTimeDrift.mockReturnValue({
      isDrifting: true,
      driftSeconds: 150,
    });

    render(<ClockDriftBanner />);

    const banner = screen.getByTestId('clock-drift-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });

  it('renders nothing when isDrifting=false (AC-6)', () => {
    mockedUseServerTimeDrift.mockReturnValue({
      isDrifting: false,
      driftSeconds: 10,
    });

    render(<ClockDriftBanner />);

    expect(screen.queryByTestId('clock-drift-banner')).not.toBeInTheDocument();
  });
});
