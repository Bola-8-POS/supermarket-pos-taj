/**
 * Queries shared by several tabs. Feature-specific queries live in src/features/<tab>/queries.ts.
 * Every fetch: parse with Zod, throw on error (React Query surfaces `error`).
 */
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { loginEligible, type LoginProfile } from './auth-policy';
import {
  CajaSessionSchema,
  GeneralSettingsSchema,
  NearExpirySettingsSchema,
  ProfileSchema,
  ShiftSchema,
  type CajaSession,
  type Profile,
  type Shift,
} from './schemas';
import { supabase } from './supabase';

export function useLoginStaff() {
  return useQuery({
    queryKey: ['staff', 'login'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<LoginProfile[]> => {
      const { data, error } = await supabase
        .from('staff_directory')
        .select('id,name,role,is_active,locale')
        .eq('is_active', true)
        .in('role', ['admin', 'manager'])
        .order('name');
      if (error) throw new Error(error.message);
      return z.array(ProfileSchema).parse(data).filter(loginEligible) as LoginProfile[];
    },
  });
}

export function useStaffList() {
  return useQuery({
    queryKey: ['staff'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Profile[]> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id,name,role,is_active,locale')
        .is('deleted_at', null)
        .order('name');
      if (error) throw new Error(error.message);
      return z.array(ProfileSchema).parse(data);
    },
  });
}

/** id → display name; unknown ids fall back to a short id. */
export function useStaffNames(): (id: string | null | undefined) => string {
  const { data } = useStaffList();
  const map = new Map((data ?? []).map(p => [p.id, p.name]));
  return id => (id ? (map.get(id) ?? id.slice(0, 8)) : '—');
}

export function useStoreName() {
  return useQuery({
    queryKey: ['settings', 'general'],
    staleTime: 60 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('settings').select('value').eq('key', 'general').maybeSingle();
      if (error) throw new Error(error.message);
      return GeneralSettingsSchema.parse(data?.value ?? {}).barName;
    },
  });
}

export function useNearExpiryDays() {
  return useQuery({
    queryKey: ['settings', 'near_expiry'],
    staleTime: 60 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('settings').select('value').eq('key', 'near_expiry').maybeSingle();
      if (error) throw new Error(error.message);
      return NearExpirySettingsSchema.parse(data?.value ?? {}).thresholdDays;
    },
  });
}

export function useCurrentCaja() {
  return useQuery({
    queryKey: ['caja', 'current'],
    queryFn: async (): Promise<CajaSession | null> => {
      const { data, error } = await supabase
        .from('caja_sessions')
        .select('id,status,opened_at,opened_by,closed_at,closed_by,opening_cash,closing_cash,notes')
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? CajaSessionSchema.parse(data) : null;
    },
  });
}

export function useOpenShifts() {
  return useQuery({
    queryKey: ['shifts', 'open'],
    queryFn: async (): Promise<Shift[]> => {
      const { data, error } = await supabase
        .from('shifts')
        .select('id,staff_id,clock_in,clock_out,opening_cash,closing_cash')
        .is('clock_out', null)
        .order('clock_in');
      if (error) throw new Error(error.message);
      return z.array(ShiftSchema).parse(data);
    },
  });
}
