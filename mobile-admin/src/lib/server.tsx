/* eslint-disable react-refresh/only-export-components -- provider and hook form one public server boundary */
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { parseServerConfig, verifyServerConfig, type ServerConfig, type ServerConfigInput } from './server-config';
import { configureSupabase, supabase } from './supabase';

const STORAGE_KEY = 'bola8pos.server.v1';

type ServerState = {
  loading: boolean;
  config: ServerConfig | null;
  saveConfig: (input: ServerConfigInput) => Promise<void>;
  clearConfig: () => Promise<void>;
};

const ServerContext = createContext<ServerState | null>(null);

function buildDefault(): ServerConfig | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  try {
    return parseServerConfig({ url, anonKey });
  } catch {
    return null;
  }
}

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<ServerConfig | null>(null);

  useEffect(() => {
    const mounted = { current: true };
    void (async () => {
      let next = buildDefault();
      try {
        const raw = await SecureStore.getItemAsync(STORAGE_KEY);
        if (raw) {
          try {
            next = parseServerConfig(JSON.parse(raw) as ServerConfigInput);
          } catch {
            next = null;
          }
        }
      } catch {
        next = buildDefault();
      }
      try {
        if (next) configureSupabase(next);
        if (mounted.current) setConfig(next);
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  const saveConfig = useCallback(async (input: ServerConfigInput) => {
    const next = parseServerConfig(input);
    await verifyServerConfig(next);
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
    configureSupabase(next);
    setConfig(next);
  }, []);

  const clearConfig = useCallback(async () => {
    await supabase.auth.signOut({ scope: 'local' });
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    setConfig(null);
  }, []);

  const value = useMemo(() => ({ loading, config, saveConfig, clearConfig }), [loading, config, saveConfig, clearConfig]);
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerState {
  const context = useContext(ServerContext);
  if (!context) throw new Error('useServer outside ServerProvider');
  return context;
}
