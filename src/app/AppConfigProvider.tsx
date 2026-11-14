import { useEffect, useState } from 'react';
import { initLicenseConfig } from '@shared/lib/license/config';
import { logger } from '@shared/lib/logger';
import { setStoreRuntimeConfig } from '@shared/lib/store-mode';
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
          storeMode?: string;
          storeCaSha256?: string;
          storeConfigError?: string;
          warnings?: string[];
        }>('get_runtime_config')
      )
      .then(cfg => {
        // A rejected (or accepted) runtime-override backend URL
        // (rust/src-tauri's is_allowed_backend_url / is_allowed_store_url) is surfaced here rather
        // than silently — read_env_config runs before any Tauri logger exists.
        for (const warning of cfg.warnings ?? []) {
          logger.warn('appConfig.runtimeOverride', { detail: warning });
        }
        // The mode first: anything that renders after this point may ask for it.
        setStoreRuntimeConfig(cfg);
        if (cfg.storeConfigError === 'STORE_ENV_UNTRUSTED_OWNER' || cfg.storeConfigError === 'STORE_ENV_UNTRUSTED_PATH') {
          // A store.env planted by a non-admin is ignored (it must not brick a cloud till); the build-time cloud client stays.
          logger.warn('appConfig.storeEnvIgnored', { code: cfg.storeConfigError });
        }
        if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
          initSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
        }
        initLicenseConfig(cfg.licenseServerUrl, cfg.licenseServerAnonKey);
      })
      .catch((e: unknown) => {
        // Fall back to the VITE_ env vars via the lazy getClient(); the store mode then stays unset (build-time value).
        logger.warn('appConfig.runtimeConfigFailed', { error: String(e) });
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
