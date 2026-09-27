import { callAgentProxy } from '@shared/lib/edge-function-contracts';
import { logger } from '@shared/lib/logger';
import type {
  AnthropicMessageParam,
  AnthropicTextBlock,
  AnthropicToolResultBlockParam,
  AnthropicToolUseBlock,
} from './anthropic-types';
import { allToolDefinitions, executeTool, WRITE_TOOLS } from './tools/index';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface PendingConfirmation {
  token: string;
  toolName: string;
  preview: unknown;
}

export interface AgentResult {
  text: string;
  toolsExecuted: string[];
  usedFallback: boolean;
  awaitingConfirmation: boolean;
  pendingConfirmation: PendingConfirmation | null;
}

// ─── Config (lazy reads — vi.stubEnv works in tests) ─────────────────────────

function getModel(): string {
  return (import.meta.env['VITE_AGENT_MODEL'] as string | undefined) ?? 'claude-sonnet-4-6';
}

function getOllamaUrl(): string {
  return (import.meta.env['VITE_OLLAMA_URL'] as string | undefined) ?? 'http://localhost:11434';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MAX_TOOL_LOOPS = 8;

// agent-proxy's own guard (supabase/functions/_shared/agent_guard.ts,
// MAX_MESSAGES) rejects any request with more than 60 messages. One turn can
// add: the trimmed history, the new user message (+1), and up to
// MAX_TOOL_LOOPS rounds of an assistant + tool-result pair each (+2 per
// round) — so the history sent has to leave room for both.
const AGENT_MAX_MESSAGES = 60;
// ponytail: trims oldest messages; summarisation if long sessions matter
const HISTORY_LIMIT = AGENT_MAX_MESSAGES - 1 - 2 * MAX_TOOL_LOOPS; // 43

// Keeps the most recent HISTORY_LIMIT messages, then drops any leading
// non-user messages so the trimmed history still starts on a user turn.
function trimHistory(history: Message[]): Message[] {
  const trimmed = history.slice(-HISTORY_LIMIT);
  const firstUserIdx = trimmed.findIndex((m) => m.role === 'user');
  return firstUserIdx === -1 ? [] : trimmed.slice(firstUserIdx);
}

// RATE_LIMITED and a role-gate FORBIDDEN are both already translated,
// user-facing messages from mapAgentProxyErrorBody — retrying immediately or
// falling back to Ollama would hide that message behind a generic offline
// notice for something retrying can't fix anyway.
const NO_RETRY_ERROR_CODES = new Set(['RATE_LIMITED', 'AUTH_FORBIDDEN']);

function asUserFacingResult(
  error: { code: string; message: string },
  toolsExecuted: string[]
): AgentResult | null {
  if (!NO_RETRY_ERROR_CODES.has(error.code)) return null;
  return {
    text: error.message,
    toolsExecuted,
    usedFallback: false,
    awaitingConfirmation: false,
    pendingConfirmation: null,
  };
}

function detectLanguage(text: string): 'es' | 'en' {
  const spanishPattern =
    /\b(el|la|los|las|un|una|de|en|que|es|por|con|para|como|del|al|se|no|si|ya|su|le|más|pero|este|esta|hay|cómo|cuánto|cuántos|qué|tienes|tiene)\b/i;
  const matches = text.match(spanishPattern);
  return matches && matches.length >= 2 ? 'es' : 'en';
}


function buildSystemPrompt(userRole: string, lang: 'es' | 'en'): string {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' });
  const langLine =
    lang === 'es'
      ? 'Respond in Spanish. Be concise and professional.'
      : 'Respond in English. Be concise and professional.';

  const parts = [
    'You are the AI assistant for Bola 8 POS, a bar and restaurant point-of-sale system.',
    `Current date/time: ${now}`,
    `User role: ${userRole}`,
    langLine,
    '',
    'You have tools to manage tabs, the menu, reports, diagnostics, and system status.',
    '',
    'TOOL RULES — follow strictly:',
    '1. NEVER invent UUIDs. Use find_product / find_tab to resolve real IDs before any write.',
    '2. For add_items_to_tab: call find_product first to get real product_id. Price is set by DB — do not pass unit_price.',
    '3. Destructive tools (close_tab, deactivate_product, bulk_import_products) return { pending: true, confirm_token, preview }.',
    '   Show the preview to the user and ask them to confirm. You never call confirm_action yourself — only the user\'s own click in the UI does. Narrate the pending action and wait.',
    '   To cancel, call cancel_action({ token }).',
    '4. If a tool returns an error, report the exact error message. Do not retry silently.',
    '5. Never call write tools more than 10 times per minute — the system will block excess calls.',
  ];

  return parts.join('\n');
}

// ─── Ollama fallback ──────────────────────────────────────────────────────────

async function runOllamaFallback(
  userMessage: string,
  history: Message[],
  userRole: string
): Promise<string> {
  const system = [
    'You are the AI assistant for Bola 8 POS.',
    `User role: ${userRole}`,
    'You are in offline mode. Answer questions concisely. You cannot execute tools.',
    'If the user asks you to perform an action, inform them you are in offline mode.',
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const resp = await fetch(`${getOllamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama3.2:3b-instruct-q4_K_M', messages, stream: false }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) throw new Error(`Ollama HTTP ${String(resp.status)}`);

  const json = (await resp.json()) as { message?: { content?: string } };
  return json.message?.content ?? '(no response from fallback model)';
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runAgent(
  userMessage: string,
  userRole: string,
  conversationHistory: Message[],
  userId?: string
): Promise<AgentResult> {
  const lang = detectLanguage(userMessage);
  const toolsExecuted: string[] = [];

  const systemPrompt = buildSystemPrompt(userRole, lang);

  const messages: AnthropicMessageParam[] = [
    ...trimHistory(conversationHistory).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'user', content: userMessage },
  ];

  let attempt = 0;
  while (attempt < 2) {
    // Whether a write tool has already run in this attempt. A failure after
    // that point must not retry the whole turn (or fall back to Ollama) —
    // the retry would replay the same write.
    let wroteThisAttempt = false;
    try {
      const firstResult = await callAgentProxy({
        model: getModel(),
        max_tokens: 1024,
        system: systemPrompt,
        tools: allToolDefinitions,
        messages,
      });
      if (!firstResult.ok) {
        const userFacing = asUserFacingResult(firstResult.error, toolsExecuted);
        if (userFacing) return userFacing;
        throw new Error(firstResult.error.message);
      }
      let response = firstResult.data;

      let loopCount = 0;
      let capturedPending: PendingConfirmation | null = null;

      while (response.stop_reason === 'tool_use' && loopCount < MAX_TOOL_LOOPS) {
        loopCount++;

        const toolBlocks = response.content.filter(
          (b): b is AnthropicToolUseBlock => b.type === 'tool_use'
        );

        // Append assistant turn before processing tools
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: AnthropicToolResultBlockParam[] = [];

        for (const block of toolBlocks) {
          // A model-issued confirm_action is refused here, before it ever
          // reaches executeTool — only the UI's own click-through (useAgent.ts)
          // may call confirm_action. See allToolDefinitions in tools/index.ts,
          // which already drops confirm_action from what the model is offered;
          // this is the backstop for a model that tries to call it anyway.
          if (block.name === 'confirm_action') {
            toolsExecuted.push(block.name);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({
                code: 'CONFIRMATION_REQUIRES_USER',
                message: 'confirm_action must be triggered by the user, not the model.',
              }),
            });
            continue;
          }

          const ctx = { userId, userRole, durationMs: undefined };
          const result = await executeTool(
            block.name,
            block.input as Record<string, unknown>,
            ctx
          );
          toolsExecuted.push(block.name);
          if (WRITE_TOOLS.has(block.name)) wroteThisAttempt = true;

          // Capture the first pending destructive action for UI confirmation dialog
          if (result.ok && capturedPending === null) {
            const d = result.data as Record<string, unknown> | null;
            if (d?.['pending'] === true) {
              capturedPending = {
                token: d['confirm_token'] as string,
                toolName: block.name,
                preview: d['preview'],
              };
            }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result.ok ? result.data : result.error),
          });
        }

        messages.push({ role: 'user', content: toolResults });

        const loopResult = await callAgentProxy({
          model: getModel(),
          max_tokens: 1024,
          system: systemPrompt,
          tools: allToolDefinitions,
          messages,
        });
        if (!loopResult.ok) {
          const userFacing = asUserFacingResult(loopResult.error, toolsExecuted);
          if (userFacing) return userFacing;
          throw new Error(loopResult.error.message);
        }
        response = loopResult.data;
      }

      const textBlock = response.content.find((b): b is AnthropicTextBlock => b.type === 'text');
      return {
        text: textBlock?.text ?? '',
        toolsExecuted,
        usedFallback: false,
        awaitingConfirmation: capturedPending !== null,
        pendingConfirmation: capturedPending,
      };
    } catch (e) {
      attempt++;
      logger.warn('brain.runAgent.claude_error', { attempt, detail: String(e) });
      if (wroteThisAttempt) {
        // A write already ran this attempt — retrying (or falling back to
        // Ollama, which can't see toolsExecuted at all) risks running the
        // same write again. Surface the failure to the user instead.
        const text =
          lang === 'es'
            ? 'La acción se ejecutó, pero ocurrió un error después. Revisa antes de intentarlo de nuevo.'
            : 'The action ran, but something went wrong afterward. Please check before trying again.';
        return {
          text,
          toolsExecuted,
          usedFallback: false,
          awaitingConfirmation: false,
          pendingConfirmation: null,
        };
      }
      if (attempt < 2) continue;
    }
  }

  // Ollama fallback after 2 Claude failures
  logger.warn('brain.runAgent.ollama_fallback', { userRole });
  try {
    const text = await runOllamaFallback(userMessage, conversationHistory, userRole);
    return { text, toolsExecuted, usedFallback: true, awaitingConfirmation: false, pendingConfirmation: null };
  } catch (fallbackErr) {
    logger.warn('brain.runAgent.fallback_failed', { detail: String(fallbackErr) });
    const text =
      lang === 'es'
        ? 'El asistente no está disponible en este momento. Intenta de nuevo más tarde.'
        : 'The assistant is currently unavailable. Please try again later.';
    return { text, toolsExecuted, usedFallback: true, awaitingConfirmation: false, pendingConfirmation: null };
  }
}
