import { describe, it, expect } from 'vitest';
import { isStaffAction, rbacDenialMessage } from './rbac';

describe('rbac', () => {
  describe('isStaffAction', () => {
    it('recognizes known actions', () => {
      expect(isStaffAction('close_tab')).toBe(true);
    });
    it('rejects unknown', () => {
      expect(isStaffAction('manage_pool_tables')).toBe(false);
    });
  });

  describe('rbacDenialMessage', () => {
    it('uses admin copy for admin-only actions', () => {
      expect(rbacDenialMessage('manage_settings')).toBe('Admin access required');
      expect(rbacDenialMessage('manage_staff')).toBe('Admin access required');
      expect(rbacDenialMessage('delete_tab')).toBe('Admin access required');
      expect(rbacDenialMessage('view_all_shifts')).toBe('Admin access required');
    });
    it('uses manager copy for manager-tier actions', () => {
      expect(rbacDenialMessage('close_tab')).toBe('Manager access required');
    });
  });
});
