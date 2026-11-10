import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { InventoryRoute } from './inventory-route';

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

const mockUsePermissions = vi.mocked(usePermissions);

function renderInventoryRoute() {
  render(
    <MemoryRouter initialEntries={['/inventory']}>
      <Routes>
        <Route path="/home" element={<div>Home page</div>} />
        <Route
          path="/inventory"
          element={
            <InventoryRoute>
              <div>Inventory content</div>
            </InventoryRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('InventoryRoute', () => {
  it('renders children when the staff member has adjust_inventory', () => {
    mockUsePermissions.mockReturnValue({ can: () => true, ready: true });

    renderInventoryRoute();

    expect(screen.getByText('Inventory content')).toBeInTheDocument();
    expect(screen.queryByText('Home page')).not.toBeInTheDocument();
  });

  it('redirects to /home when the staff member lacks adjust_inventory', () => {
    mockUsePermissions.mockReturnValue({ can: () => false, ready: true });

    renderInventoryRoute();

    expect(screen.getByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Inventory content')).not.toBeInTheDocument();
  });

  it('renders nothing while the matrix has not settled', () => {
    mockUsePermissions.mockReturnValue({ can: () => false, ready: false });

    renderInventoryRoute();

    expect(screen.queryByText('Inventory content')).not.toBeInTheDocument();
    expect(screen.queryByText('Home page')).not.toBeInTheDocument();
  });
});
