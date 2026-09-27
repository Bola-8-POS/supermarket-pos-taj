import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import { mockStaff } from '@entities/staff/model/types';
import type { Shift } from '@shared/lib/domain';
import { ProtectedRoute } from './ProtectedRoute';

const testShift: Shift = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  staffId: mockStaff[0]!.id,
  clockIn: new Date(),
  clockOut: null,
  openingCash: 0,
  closingCash: null,
};

describe('ProtectedRoute', () => {
  beforeEach(() => {
    useStaffStore.getState().logout();
    useStaffStore.setState({ hasHydrated: true });
  });

  it('redirects to /login when staffStore is not authenticated', () => {
    render(
      <MemoryRouter initialEntries={['/pos']}>
        <Routes>
          <Route path="/login" element={<div>Login page</div>} />
          <Route
            path="/pos"
            element={
              <ProtectedRoute>
                <div>POS content</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('Login page')).toBeInTheDocument();
    expect(screen.queryByText('POS content')).not.toBeInTheDocument();
  });

  it('renders children when staffStore is authenticated', () => {
    useStaffStore.getState().login(mockStaff[0]!, testShift);

    render(
      <MemoryRouter initialEntries={['/pos']}>
        <Routes>
          <Route path="/login" element={<div>Login page</div>} />
          <Route
            path="/pos"
            element={
              <ProtectedRoute>
                <div>POS content</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('POS content')).toBeInTheDocument();
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });

  it('renders neither children nor redirects while persist has not hydrated yet', () => {
    useStaffStore.setState({ hasHydrated: false });

    render(
      <MemoryRouter initialEntries={['/pos']}>
        <Routes>
          <Route path="/login" element={<div>Login page</div>} />
          <Route
            path="/pos"
            element={
              <ProtectedRoute>
                <div>POS content</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.queryByText('POS content')).not.toBeInTheDocument();
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });
});
