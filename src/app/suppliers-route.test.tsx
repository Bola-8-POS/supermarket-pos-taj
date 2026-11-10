import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { SuppliersRoute } from './suppliers-route';

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

const mockUsePermissions = vi.mocked(usePermissions);

function renderSuppliersRoute() {
  render(
    <MemoryRouter initialEntries={['/suppliers']}>
      <Routes>
        <Route path="/home" element={<div>Home page</div>} />
        <Route
          path="/suppliers"
          element={
            <SuppliersRoute>
              <div>Suppliers content</div>
            </SuppliersRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('SuppliersRoute', () => {
  it('renders children when the staff member has manage_products', () => {
    mockUsePermissions.mockReturnValue({ can: () => true, ready: true });

    renderSuppliersRoute();

    expect(screen.getByText('Suppliers content')).toBeInTheDocument();
    expect(screen.queryByText('Home page')).not.toBeInTheDocument();
  });

  it('redirects to /home when the staff member lacks manage_products', () => {
    mockUsePermissions.mockReturnValue({ can: () => false, ready: true });

    renderSuppliersRoute();

    expect(screen.getByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Suppliers content')).not.toBeInTheDocument();
  });

  it('renders nothing while the matrix has not settled', () => {
    mockUsePermissions.mockReturnValue({ can: () => false, ready: false });

    renderSuppliersRoute();

    expect(screen.queryByText('Suppliers content')).not.toBeInTheDocument();
    expect(screen.queryByText('Home page')).not.toBeInTheDocument();
  });
});
