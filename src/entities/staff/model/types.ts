import {
  StaffSchema,
  StaffUpdateSchema,
  ShiftSchema,
} from '@shared/lib/domain';
import type {
  Staff,
} from '@shared/lib/domain';

export {
  StaffSchema,
  StaffUpdateSchema,
  ShiftSchema,
};

export type { Staff };

// Re-export mock data if needed, but ideally move to shared mocks
/* eslint-disable i18next/no-literal-string -- Storybook fixture data, not UI copy. */
export const mockStaff: Staff[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Alex Martinez',
    role: 'cashier',
    isActive: true,
    mustChangePin: false,
    locale: 'es-MX',
  },
  {
    id: '22222222-3333-4444-5555-666666666666',
    name: 'Jamie Chen',
    role: 'manager',
    isActive: true,
    mustChangePin: false,
    locale: 'es-MX',
  },
];
