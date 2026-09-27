import type { Result } from '@shared/lib/result';
import type { AgentActionContext } from '@shared/lib/telemetry';

export type ExecutorFn = (
  args: Record<string, unknown>,
  ctx: AgentActionContext
) => Promise<Result<unknown>>;

interface PendingAction {
  toolName: string;
  args: Record<string, unknown>;
  preview: unknown;
  executor: ExecutorFn;
  expiresAt: number;
}

const store = new Map<string, PendingAction>();
const TTL_MS = 5 * 60_000;

function purgeExpired(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt < now) store.delete(k);
  }
}

export function createPendingAction(
  toolName: string,
  args: Record<string, unknown>,
  preview: unknown,
  executor: ExecutorFn
): string {
  purgeExpired();
  const token = Math.random().toString(36).slice(2, 10);
  store.set(token, { toolName, args, preview, executor, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function consumePendingAction(token: string): PendingAction | null {
  purgeExpired();
  const action = store.get(token);
  if (!action) return null;
  store.delete(token);
  return action;
}

export function cancelPendingAction(token: string): boolean {
  return store.delete(token);
}
