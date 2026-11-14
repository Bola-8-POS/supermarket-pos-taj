import { getTerminalId, getTerminalName } from '../license/terminal-id';
import { restUrl, supabase } from '../supabase';
import { StoreSwitchStateSchema, StoreSwitchStatusRowSchema, type StoreSwitchState } from './types';

interface Reply {
  data: unknown;
  error: { message: string } | null;
}
interface Loose {
  from(table: string): { select(columns: string): { maybeSingle(): PromiseLike<Reply> } };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Reply>;
}
// ponytail: the generated types do not know the new view and RPC yet; after `supabase gen types` drop this cast.
const loose = (): Loose => supabase as unknown as Loose;

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0';

/** Identifies the backend this till talks to (the PostgREST base URL); 'unknown' before the client exists. */
export function backendKey(): string {
  try {
    return restUrl();
  } catch {
    return 'unknown';
  }
}

/** null = unknown (error, missing view on an older backend, offline). Callers fail open on null. */
export async function fetchStoreSwitchState(): Promise<StoreSwitchState | null> {
  try {
    const { data, error } = await loose().from('store_switch_status').select('state').maybeSingle();
    if (error || data == null) return null;
    const parsed = StoreSwitchStatusRowSchema.safeParse(data);
    return parsed.success ? parsed.data.state : null;
  } catch {
    return null;
  }
}

export interface TillSyncInput {
  queueDepth: number;
  deadLetterDepth: number;
  seenState: StoreSwitchState;
}

/** One call both reports this till's unsynced work and learns the effective state. */
export async function reportTillSync(input: TillSyncInput): Promise<StoreSwitchState | null> {
  try {
    const { data, error } = await loose().rpc('report_till_sync', {
      p_terminal_uuid: getTerminalId(),
      p_terminal_label: getTerminalName(),
      p_queue_depth: input.queueDepth,
      p_dead_letter_depth: input.deadLetterDepth,
      p_seen_state: input.seenState,
      p_app_version: APP_VERSION,
    });
    if (error) return null;
    const parsed = StoreSwitchStateSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
