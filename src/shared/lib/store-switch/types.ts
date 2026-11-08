import { z } from 'zod';

export const StoreSwitchStateSchema = z.enum(['active', 'draining', 'frozen', 'moved']);
export type StoreSwitchState = z.infer<typeof StoreSwitchStateSchema>;

/** One row of the public view store_switch_status (hosted migration 20261025000001). */
export const StoreSwitchStatusRowSchema = z.object({ state: StoreSwitchStateSchema });
