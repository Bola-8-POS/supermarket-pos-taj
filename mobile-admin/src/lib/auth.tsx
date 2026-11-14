/* eslint-disable react-refresh/only-export-components -- provider and hook form one public auth boundary */
import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { ALLOWED_ROLES } from './auth-policy';
import { ProfileSchema, type Profile } from './schemas';
import { useServer } from './server';
import { completeStaffSignIn, type StaffSignInOutcome } from './staff-sign-in';
import { supabase } from './supabase';

type AuthState = {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  /** Set when signed in but role is not admin/manager. */
  roleDenied: boolean;
  signIn: (staffId: string, pin: string) => Promise<StaffSignInOutcome>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id,name,role,is_active,locale')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const parsed = ProfileSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const { config } = useServer();

  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      if (data.session) setProfile(await loadProfile(data.session.user.id));
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      if (!alive) return;
      setSession(s);
      setProfile(null);
      // Supabase warns against awaiting another client call inside this callback.
      if (s) {
        setTimeout(() => {
          void loadProfile(s.user.id).then(next => {
            if (alive) setProfile(next);
          });
        }, 0);
      }
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(
    async (staffId: string, pin: string): Promise<StaffSignInOutcome> => {
      if (!config) return { kind: 'UNAVAILABLE' };
      return completeStaffSignIn(config, staffId, pin, { fetchFn: fetch, auth: supabase.auth });
    },
    [config]
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      profile,
      roleDenied: !!session && !!profile && (!profile.is_active || !ALLOWED_ROLES.has(profile.role)),
      signIn,
      signOut,
    }),
    [loading, session, profile, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
