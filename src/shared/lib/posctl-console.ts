import { z } from 'zod';
import { logger } from './logger';
import { err, ok, type Result } from './result';
import type { ConsoleAction } from './store-alerts';

export const ConsoleLaunchSchema = z.enum(['Launched', 'Declined', 'NotInstalled', 'Untrusted']);
export type ConsoleLaunch = z.infer<typeof ConsoleLaunchSchema>;

/**
 * Reopens the elevated posctl console for one fixed action (the Rust side maps the action to its argv).
 * Nothing sensitive crosses this call: no PIN, no pair code, no path.
 */
export async function openPosctlConsole(action: ConsoleAction): Promise<Result<ConsoleLaunch>> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<unknown>('posctl_open_console', { action });
    const parsed = ConsoleLaunchSchema.safeParse(raw);
    return parsed.success
      ? ok(parsed.data)
      : err({ code: 'VALIDATION_ERROR', message: 'unexpected launcher answer' });
  } catch {
    // the command's own message is not shown: it can name a path
    logger.warn('posctl_console.invoke_failed', { action });
    return err({ code: 'UNKNOWN_ERROR', message: 'console could not be opened' });
  }
}
