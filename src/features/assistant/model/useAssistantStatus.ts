import { useQuery } from '@tanstack/react-query';
import type { AssistantStatus } from '@shared/lib/domain';
import { createLocalModel, isTauriRuntime } from '@shared/lib/local-assistant/model';

/** The one renderer-side handle to the local model (invoke only, never fetch). */
export const localModel = createLocalModel();

// eslint-disable-next-line i18next/no-literal-string -- TanStack Query cache key, not UI copy
export const assistantStatusKey = ['assistant', 'status'] as const;

/** Bridge status, polled every 30 s under Tauri. Anything unreadable is `unavailable`. */
export function useAssistantStatus() {
  return useQuery<AssistantStatus>({
    queryKey: assistantStatusKey,
    queryFn: () => localModel.status(),
    refetchInterval: isTauriRuntime() ? 30_000 : false,
    staleTime: 10_000,
  });
}

/** `modelId@runtimeTag`, stored with every staged write (AI-SPEC audit: which model proposed it). */
export function modelTag(status: AssistantStatus): string {
  // eslint-disable-next-line i18next/no-literal-string -- audit value, not UI copy
  return `${status.modelId ?? 'unknown'}@${status.runtimeTag ?? 'unknown'}`;
}
