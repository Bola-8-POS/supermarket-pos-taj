/**
 * Renderer side of the local model bridge (Plan 29-02 commands). The model is reached ONLY through Tauri
 * `invoke`; the loopback port and key live in Rust and never reach the webview, so nothing here uses fetch
 * (Plan 29-08 guard test).
 */
import { invoke } from '@tauri-apps/api/core';
import { AssistantStatusSchema, type AssistantStatus } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, type Result } from '@shared/lib/result';
import type { ChatMessage } from './prompt';
import { proposalJsonSchema, type AssistantError } from './proposal';

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export type LocalModel = {
  /** Resolves the raw model content string (untrusted: the caller must parseProposal it). */
  propose(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<Result<string, AssistantError>>;
  status(): Promise<AssistantStatus>;
};

const UNAVAILABLE: AssistantStatus = { state: 'unavailable', reason: null, modelId: null, runtimeTag: null };

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Bridge rejections are a code string (or `{ code }`); anything else is treated as unavailable. */
function bridgeCode(e: unknown): string {
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    const message = (e as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'UNAVAILABLE';
}

function toAssistantError(e: unknown): AssistantError {
  switch (bridgeCode(e)) {
    case 'TIMEOUT':
      return { code: 'MODEL_TIMEOUT' };
    case 'BAD_RESPONSE':
      return { code: 'INVALID_PROPOSAL' };
    default:
      return { code: 'MODEL_UNAVAILABLE' };
  }
}

export function createLocalModel(invokeFn: InvokeFn = invoke): LocalModel {
  return {
    async propose(messages, signal) {
      if (!isTauriRuntime()) return err({ code: 'MODEL_UNAVAILABLE' });
      const requestId = crypto.randomUUID();
      const onAbort = () => {
        void invokeFn('assistant_cancel', { requestId }).catch(() => undefined);
      };
      if (signal?.aborted) return err({ code: 'MODEL_UNAVAILABLE' });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const content = await invokeFn('assistant_infer', { requestId, messages, schema: proposalJsonSchema });
        return typeof content === 'string' ? ok(content) : err({ code: 'INVALID_PROPOSAL' });
      } catch (e) {
        const error = toAssistantError(e);
        logger.warn('assistant.model.failed', { code: error.code });
        return err(error);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async status() {
      if (!isTauriRuntime()) return UNAVAILABLE;
      try {
        const parsed = AssistantStatusSchema.safeParse(await invokeFn('assistant_status'));
        return parsed.success ? parsed.data : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}
