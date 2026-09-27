/**
 * Minimal local type definitions replacing `@anthropic-ai/sdk`'s type imports.
 *
 * Phase 06 (SEC-01): the Anthropic SDK is removed from client dependencies
 * entirely — every Anthropic call now goes through the `agent-proxy` edge
 * function via `callAgentProxy()`. These interfaces cover only the exact
 * surface `brain.ts`/`vision.ts` consume, not the SDK's full type surface.
 */

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

// Anthropic may return other content-block types (e.g. thinking, redacted_thinking)
// that brain.ts/vision.ts never narrow on — catch-all member keeps this a valid
// union member for those without widening the two type-guarded members above.
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | { type: string; [key: string]: unknown };

export interface AnthropicToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[] | AnthropicToolResultBlockParam[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface AnthropicMessage {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
}
