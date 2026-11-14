import type { Profile } from './schemas';

export const ALLOWED_ROLES = new Set<Profile['role']>(['admin', 'manager']);
export type LoginProfile = Profile & { role: 'admin' | 'manager' };

export function loginEligible(
  profile: Pick<Profile, 'is_active' | 'role'>
): profile is Pick<Profile, 'is_active' | 'role'> & { role: 'admin' | 'manager' } {
  return profile.is_active && ALLOWED_ROLES.has(profile.role);
}
