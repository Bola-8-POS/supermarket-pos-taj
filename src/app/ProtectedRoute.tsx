import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useStaffStore } from '@entities/staff/model/store';
import { isSupabaseSessionReady, waitForSupabaseSessionReady } from '@shared/lib/supabase';

interface ProtectedRouteProps {
  children: ReactNode;
}

/**
 * Bounded grace window for zustand's persist hydration (see store.ts
 * `hasHydrated`) and for supabase-js's own async session restore (see
 * `waitForSupabaseSessionReady`). Never block longer than this even if either
 * signal never fires for any reason — a permanently blank screen is a worse
 * failure mode than the rare pre-ready redirect / anonymous-query race this
 * is meant to prevent.
 */
const READY_GRACE_MS = 300;

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const isAuthenticated = useStaffStore(s => s.isAuthenticated);
  const hasHydrated = useStaffStore(s => s.hasHydrated);
  const [sessionReady, setSessionReady] = useState(isSupabaseSessionReady());
  const [graceElapsed, setGraceElapsed] = useState(false);

  const isReady = hasHydrated && sessionReady;

  useEffect(() => {
    if (sessionReady) return;
    let cancelled = false;
    void waitForSupabaseSessionReady().then(() => {
      if (!cancelled) setSessionReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionReady]);

  useEffect(() => {
    if (isReady) return;
    const timer = setTimeout(() => {
      setGraceElapsed(true);
    }, READY_GRACE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isReady]);

  // zustand's persist middleware restores localStorage in a microtask, and
  // supabase-js restores its own auth session asynchronously — both run
  // after React's first paint. Rendering children (which mount RLS-gated
  // queries) or deciding `isAuthenticated` before both are ready means a
  // fresh page load either bounces an authenticated user to /login or fires
  // queries with no auth header, silently caching an empty/wrong result.
  if (!isReady && !graceElapsed) {
    return null;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
