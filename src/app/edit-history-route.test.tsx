import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePermissions } from '@entities/staff/model/usePermissions';
import type * as FeaturesModule from '@shared/lib/license/features';
import { EditHistoryRoute } from './edit-history-route';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

const featureState = { enabled: true };
vi.mock('@shared/lib/license/features', async importOriginal => {
  const actual = await importOriginal<typeof FeaturesModule>();
  return {
    ...actual,
    useFeature: () => ({
      enabled: featureState.enabled,
      locked: !featureState.enabled,
      requestUpgrade: vi.fn(),
    }),
  };
});

const mockUsePermissions = vi.mocked(usePermissions);

function renderEditHistoryRoute() {
  render(
    <MemoryRouter initialEntries={['/edit-history']}>
      <Routes>
        <Route path="/home" element={<div>Home page</div>} />
        <Route
          path="/edit-history"
          element={
            <EditHistoryRoute>
              <div>Edit history content</div>
            </EditHistoryRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('EditHistoryRoute', () => {
  beforeEach(() => {
    featureState.enabled = true;
  });

  it('renders children when the staff member has view_audit_log', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });

    renderEditHistoryRoute();

    expect(screen.getByText('Edit history content')).toBeInTheDocument();
    expect(screen.queryByText('Home page')).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('redirects to /home and toasts when the staff member lacks view_audit_log', () => {
    mockUsePermissions.mockReturnValue({ can: () => false });

    renderEditHistoryRoute();

    expect(screen.getByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Edit history content')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('This page is restricted to managers and admins.');
  });

  it('renders the feature-locked page when RBAC allows but the license lacks edit_history', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });
    featureState.enabled = false;

    renderEditHistoryRoute();

    const lockedPage = screen.getByTestId('feature-locked-page');
    expect(lockedPage).toHaveAttribute('data-feature', 'edit_history');
    expect(screen.queryByText('Edit history content')).not.toBeInTheDocument();
    expect(screen.queryByText('Home page')).not.toBeInTheDocument();
  });
});
