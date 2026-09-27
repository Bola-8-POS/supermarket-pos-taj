import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { WEB_CSP, isAllowedBackendUrl } from "./scripts/csp";

/** Backend override variables the build-time host guard checks — same two
 * VITE_* keys the desktop runtime override (src-tauri/src/lib.rs) validates. */
const BACKEND_URL_ENV_KEYS = ["VITE_SUPABASE_URL", "VITE_LICENSE_SERVER_URL"] as const;

/** Inserts extra origins into an existing `connect-src` directive (never
 * appended as a whole new directive) — used only by the CSP Playwright
 * config, which sets `CSP_EXTRA_CONNECT` to the local stack's actual
 * host:port (127.0.0.1 or localhost, whichever the run uses) so the preview
 * server's policy matches wherever Supabase is really listening. */
function withExtraConnectSrc(csp: string, extra: string): string {
  return csp.replace(/connect-src ([^;]*)/, (_match, directives: string) =>
    `connect-src ${directives} ${extra}`.trim()
  );
}

// https://vite.dev/config/
export default defineConfig(async ({ command, mode }) => {
  // Release builds template VITE_* values into `.env.production` (read here
  // via loadEnv), not the process environment `npm run build` inherits —
  // `process.env` alone would never see a customer's Supabase/license URL.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "VITE_") };

  // @ts-expect-error process is a nodejs global
  const host = process.env.TAURI_DEV_HOST;

  if (command === "build") {
    for (const key of BACKEND_URL_ENV_KEYS) {
      const value = env[key];
      if (value && !isAllowedBackendUrl(value)) {
        throw new Error(
          `${key} is not an allowed backend host (must be https to *.supabase.co/*.supabase.in, or http(s) to localhost/127.0.0.1): ${value}`
        );
      }
    }
  }

  // Set only by playwright.csp.config.ts, so the CSP the Vite preview server
  // sends under the CSP e2e suite reaches the local Supabase stack wherever
  // it actually is (127.0.0.1 vs localhost) without hard-coding either into
  // the committed WEB_CSP that firebase.json ships.
  // @ts-expect-error process is a nodejs global
  const cspExtraConnect: string | undefined = process.env.CSP_EXTRA_CONNECT;
  const previewCsp = cspExtraConnect ? withExtraConnectSrc(WEB_CSP, cspExtraConnect) : WEB_CSP;

  return {
    plugins: [react()],

    resolve: {
      alias: {
        "@app": path.resolve(__dirname, "./src/app"),
        "@pages": path.resolve(__dirname, "./src/pages"),
        "@widgets": path.resolve(__dirname, "./src/widgets"),
        "@features": path.resolve(__dirname, "./src/features"),
        "@entities": path.resolve(__dirname, "./src/entities"),
        "@shared": path.resolve(__dirname, "./src/shared"),
      },
    },

    optimizeDeps: {
      include: ['immer'],
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      // Distinct from the sibling bar-pos project, which is fixed on 1420/1421.
      port: 1520,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1521,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        // 4. also ignore Playwright's own output directories — traces/videos/
        //    screenshots are written continuously *during* an e2e run, and
        //    without this, Vite's fs watcher treats those writes as source
        //    changes and full-page-reloads the app under test mid-run,
        //    intermittently wiping in-progress dialog/form state and causing
        //    flaky "element not found" failures unrelated to the app itself.
        ignored: [
          "**/src-tauri/**",
          "**/e2e-results/**",
          "**/playwright-report/**",
          "**/e2e-blob-reports/**",
        ],
      },
    },

    // `vite preview` header — the web build's runtime CSP (matches
    // firebase.json's hosting header for the same file, `WEB_CSP`; the CSP
    // Playwright suite is the only thing that ever sets CSP_EXTRA_CONNECT).
    preview: {
      headers: {
        "Content-Security-Policy": previewCsp,
      },
    },
  };
});
