import { useEffect, useState } from 'react';
import { initLicenseConfig } from '@shared/lib/license/config';
import { logger } from '@shared/lib/logger';
import { initSupabaseClient } from '@shared/lib/supabase';
import { LoadingSpinner } from '@shared/ui/LoadingSpinner';

interface Props {
  children: React.ReactNode;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function AppConfigProvider({ children }: Props) {
  // In non-Tauri environments (dev server / tests) skip the command
  const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
  const [ready, setReady] = useState(!isTauri);

  useEffect(() => {
    if (!isTauri) return;

    import('@tauri-apps/api/core')
      .then(({ invoke }) =>
        invoke<{
          supabaseUrl: string;
          supabaseAnonKey: string;
          licenseServerUrl?: string;
          licenseServerAnonKey?: string;
          warnings?: string[];
        }>('get_runtime_config')
      )
      .then(cfg => {
        // A rejected (or accepted) runtime-override backend URL
        // (rust/src-tauri's is_allowed_backend_url) is surfaced here rather
        // than silently — read_env_config runs before any Tauri logger exists.
        for (const warning of cfg.warnings ?? []) {
          logger.warn('appConfig.runtimeOverride', { detail: warning });
        }
        if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
          initSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
        }
        initLicenseConfig(cfg.licenseServerUrl, cfg.licenseServerAnonKey);
      })
      .catch(() => {
        /* fallback to VITE_ env vars via lazy getClient() */
      })
      .finally(() => {
        setReady(true);
      });
  }, [isTauri]);

  if (!ready) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background">
        <LoadingSpinner size={28} />
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </div>
    );
  }

  return <>{children}</>;
}
