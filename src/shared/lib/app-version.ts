/** Installed app version. Build injects VITE_APP_VERSION (vite.config.ts: env, else package.json). */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || '0.0.0';
