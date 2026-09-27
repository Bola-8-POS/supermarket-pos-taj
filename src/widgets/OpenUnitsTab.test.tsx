import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
// Real i18next singleton (not mocked) — resolves t('wAdmin:openUnitsTab.*')
// to the actual catalog values.
import '@shared/lib/i18n';
import { OpenUnitsTab } from './OpenUnitsTab';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const roleState: { role: 'admin' | 'manager' | 'cashier' | null } = {
  role: 'manager',
};

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (selector: (state: { currentStaff: { role: string } | null }) => unknown) =>
    selector({
      currentStaff: roleState.role ? { role: roleState.role } : null,
    }),
}));

type OpenUnitFixture = {
  id: string;
  remainingCount: number;
  openedBy: string | null;
  openedAt: Date;
  product?: { name: string; unitsPerPackage: number | null };
};

const openUnitsState: {
  data: OpenUnitFixture[] | undefined;
  isLoading: boolean;
  resultError: { message: string } | undefined;
  isEmpty: boolean;
} = {
  data: [],
  isLoading: false,
  resultError: undefined,
  isEmpty: true,
};

vi.mock('@entities/open-unit', () => ({
  useOpenUnits: () => ({
    data: openUnitsState.data,
    isLoading: openUnitsState.isLoading,
    resultError: openUnitsState.resultError,
    isEmpty: openUnitsState.isEmpty,
  }),
}));

const productsState: { data: { id: string; name: string; unitsPerPackage: number | null }[] } = {
  data: [{ id: 'prod-1', name: 'Marlboro', unitsPerPackage: 20 }],
};

vi.mock('@entities/product', () => ({
  useProducts: () => ({ data: productsState.data }),
}));

vi.mock('@features/open-open-unit', () => ({
  OpenUnitButton: ({ disabled }: { disabled?: boolean }) =>
    createElement('button', { type: 'button', disabled }, 'Open a new unit'),
}));

vi.mock('@features/correct-open-unit', () => ({
  CorrectOpenUnitDialog: ({ open }: { open: boolean }) =>
    open ? createElement('div', null, 'Correct dialog open') : null,
}));

vi.mock('@features/void-open-unit', () => ({
  VoidOpenUnitDialog: ({ open }: { open: boolean }) =>
    open ? createElement('div', null, 'Void dialog open') : null,
}));

function fixture(overrides: Partial<OpenUnitFixture> = {}): OpenUnitFixture {
  return {
    id: 'ou-1',
    remainingCount: 15,
    openedBy: 'staff-1',
    openedAt: new Date('2026-07-30T12:00:00Z'),
    product: { name: 'Marlboro', unitsPerPackage: 20 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenUnitsTab', () => {
  beforeEach(() => {
    roleState.role = 'manager';
    openUnitsState.data = [];
    openUnitsState.isLoading = false;
    openUnitsState.resultError = undefined;
    openUnitsState.isEmpty = true;
  });

  it('renders one row per active open unit with product, remaining count, opener, and opened-at', () => {
    openUnitsState.data = [fixture()];
    openUnitsState.isEmpty = false;
    render(createElement(OpenUnitsTab));

    const table = screen.getByRole('table');
    expect(within(table).getByText('Marlboro')).toBeInTheDocument();
    expect(within(table).getByText('15')).toBeInTheDocument();
    expect(within(table).getByText('staff-1')).toBeInTheDocument();
  });

  it('cashier role: open-new-unit control is present/enabled; correct and void are not actionable', async () => {
    const user = userEvent.setup();
    roleState.role = 'cashier';
    openUnitsState.data = [fixture()];
    openUnitsState.isEmpty = false;
    render(createElement(OpenUnitsTab));

    // Selecting a package product enables the ungated open-new-unit control
    // regardless of role (D-11) — the button starts disabled only because no
    // product is chosen yet, not because of any RBAC gate.
    await user.selectOptions(screen.getByLabelText(/open a new unit|abrir una nueva unidad/i), [
      'prod-1',
    ]);
    expect(screen.getByRole('button', { name: /open a new unit/i })).toBeEnabled();

    const table = screen.getByRole('table');
    expect(within(table).getByRole('button', { name: /correct|corregir/i })).toBeDisabled();
    expect(within(table).getByRole('button', { name: /void|anular/i })).toBeDisabled();
  });

  it('manager role: correct and void controls are available (enabled)', () => {
    roleState.role = 'manager';
    openUnitsState.data = [fixture()];
    openUnitsState.isEmpty = false;
    render(createElement(OpenUnitsTab));

    expect(screen.getByRole('button', { name: /correct|corregir/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /void|anular/i })).toBeEnabled();
  });

  it('renders an empty-state message and no rows when there are zero active units, but keeps the open-new-unit control available', () => {
    openUnitsState.data = [];
    openUnitsState.isEmpty = true;
    render(createElement(OpenUnitsTab));

    expect(screen.getByText(/no active open units|no hay unidades abiertas/i)).toBeInTheDocument();
    expect(screen.queryByText('Marlboro', { selector: 'td *, td' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open a new unit/i })).toBeInTheDocument();
  });

  it('renders the loading state, not the empty state, while the query is loading', () => {
    openUnitsState.data = undefined;
    openUnitsState.isLoading = true;
    openUnitsState.isEmpty = false;
    render(createElement(OpenUnitsTab));

    expect(
      screen.queryByText(/no active open units|no hay unidades abiertas/i)
    ).not.toBeInTheDocument();
  });

  it('renders a query error message in a role="alert" element', () => {
    openUnitsState.resultError = { message: 'Could not load open units' };
    render(createElement(OpenUnitsTab));

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load open units');
  });

  it('D-06: a row with remainingCount of 1 carries neither the "amber" nor "destructive" highlight token in its row className', () => {
    openUnitsState.data = [fixture({ remainingCount: 1 })];
    openUnitsState.isEmpty = false;
    render(createElement(OpenUnitsTab));

    const table = screen.getByRole('table');
    const row = within(table).getByText('Marlboro').closest('tr');
    expect(row).not.toBeNull();
    expect(row?.className ?? '').not.toMatch(/amber/);
    expect(row?.className ?? '').not.toMatch(/destructive/);
  });
});
