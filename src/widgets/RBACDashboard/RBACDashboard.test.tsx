import { describe, it } from 'vitest';

describe('RBACDashboard', () => {
  it.todo('renders DataTable with Name, Role, and Edit Role columns');
  it.todo(
    'clicking Edit Role button for a row opens EditRoleDialog with preSelectedStaffId set to that row staff id'
  );
  it.todo('Edit Role button is disabled for the currently logged-in staff member (cannot self-edit)');
  it.todo('shows loading state while staff list is loading');
  it.todo('Add Staff stub button triggers toast message');
  it.todo('Deactivate stub button triggers toast message');
});
