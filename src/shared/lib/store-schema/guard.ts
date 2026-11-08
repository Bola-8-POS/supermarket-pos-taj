import { isOnline } from '../connectivity';
import { isBlocking, type BlockingState } from './classify';
import { getExpectedSchema } from './expected';
import { useStoreSchemaStore } from './store';

export const FRESH_MS = 5_000;

function refusal(s: BlockingState): Error {
  const want = getExpectedSchema();
  const have = s.server ? `${s.server.maxVersion}/${String(s.server.applied)}` : 'none';
  return new Error(`STORE_SCHEMA_MISMATCH: ${s.kind} (server ${have}, till ${want.maxVersion}/${String(want.applied)})`);
}

/**
 * The write guard (plan table). Resolves when the write may be sent, rejects with
 * `STORE_SCHEMA_MISMATCH: ...` when the store is at a different schema level.
 * An unreachable probe lets the write through: the offline layer owns that case.
 */
export async function guardWrite(): Promise<void> {
  const store = useStoreSchemaStore.getState();
  if (isBlocking(store.state)) throw refusal(store.state);
  if (store.state.kind === 'ok' && Date.now() - store.checkedAt < FRESH_MS) return;
  if (!isOnline()) return;
  const next = await store.refresh();
  if (isBlocking(next)) throw refusal(next);
}
