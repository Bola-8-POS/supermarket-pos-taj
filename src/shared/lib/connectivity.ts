import { useEffect, useState } from 'react';

/**
 * Returns true if the browser currently has a network connection.
 * Safe to call outside of React (e.g. in Zustand actions).
 */
export function isOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

/**
 * Reactive hook that tracks the browser's online/offline status.
 * Subscribes to the window 'online' and 'offline' events.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(isOnline);

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
    };
    const handleOffline = () => {
      setOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}
