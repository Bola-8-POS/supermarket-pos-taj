import { describe, it } from 'vitest';

describe('EditRoleDialog — preSelectedStaffId prop', () => {
  it.todo(
    'when preSelectedStaffId is provided and dialog opens, selectedStaffId state is seeded with that value'
  );
  it.todo(
    'when preSelectedStaffId is undefined and dialog opens, selectedStaffId state remains empty string'
  );
  it.todo(
    'when dialog closes and reopens with a different preSelectedStaffId, the new id is seeded (not stale)'
  );
  it.todo('reset on close still clears selectedStaffId regardless of preSelectedStaffId');
});
