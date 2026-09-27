/**
 * STAFF ENTITY - BARREL EXPORT
 */

// Types & Schemas
export { StaffSchema, ShiftSchema, // Keep alias if needed or just fix downstream
  StaffUpdateSchema as UpdateStaffSchema } from './types';

export type { Staff } from './types';
export type { ShiftClosePreview } from './queries';

// State Management
export { useStaffStore } from './store';
export { useLoginUiStore } from './loginUiStore';

// Data Fetching
export { staffKeys, useStaffList, useOpenShifts, useShiftClosePreview, useMutationClockIn, useMutationClockOut, useStaffMetrics } from './queries';
export { usePermissions } from './usePermissions';
