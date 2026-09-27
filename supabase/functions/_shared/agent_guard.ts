// Pure request-shape guard for agent-proxy. No Deno.serve, no network, no
// DB -- covers the model allow-list and every request cap so the logic is
// unit-testable without a running edge runtime. Kitchen role / caller
// identity is verifyCaller's job (already generic, not agent-specific);
// rate limiting is _shared/rate_limit.ts's job.
//
// A local error type, since AppError (src/shared/lib/result.ts) is a
// client type and not importable from supabase/functions.

export interface AgentProxyBody {
  model: string
  max_tokens: number
  system?: string
  tools?: unknown[]
  messages: unknown[]
}

export interface AgentGuardEnv {
  allowedModels: string[]
}

export interface AgentGuardError {
  code: string
  message: string
}

const MAX_SYSTEM_CHARS = 20_000
// Every string field across system/messages/tools except base64 image
// block data -- string .length (UTF-16 code units) stands in for bytes
// here, close enough for a request-size cap.
const MAX_TEXT_CHARS = 200_000
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024 // Anthropic's own per-image base64 limit
const MAX_IMAGES = 4
const MAX_TOKENS_CAP = 4096
const MAX_MESSAGES = 60
const MAX_TOOLS = 40

interface Totals {
  textChars: number
  imageCount: number
  imageOversize: boolean
}

function isImageBlock(value: unknown): value is { type: 'image'; source?: { data?: unknown } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'image' &&
    typeof (value as { source?: unknown }).source === 'object' &&
    (value as { source?: unknown }).source !== null
  )
}

// Walks any JSON value (messages/tools are opaque per D-01's thin-proxy
// framing), summing every string it finds except an image block's own
// base64 source.data, which is tracked separately as an image instead.
function walk(value: unknown, totals: Totals): void {
  if (typeof value === 'string') {
    totals.textChars += value.length
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, totals)
    return
  }
  if (value !== null && typeof value === 'object') {
    if (isImageBlock(value)) {
      totals.imageCount += 1
      const data = value.source?.data
      if (typeof data === 'string' && data.length > MAX_IMAGE_BASE64_CHARS) {
        totals.imageOversize = true
      }
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'source') continue // its `data` is image payload, not text
        walk(v, totals)
      }
      return
    }
    for (const v of Object.values(value as Record<string, unknown>)) walk(v, totals)
  }
}

// A request may not offer the model the confirmation tool at all -- pairs
// with filterModelResponse below, which strips a confirm_action block the
// model tries to issue anyway. Together they keep an unmodified client from
// ever completing a model-issued confirmation server-side (a modified
// client still runs its own local confirmation loop; see the plan's ruling
// 2 for that accepted limit).
function isConfirmActionTool(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'confirm_action'
  )
}

export function checkAgentRequest(body: AgentProxyBody, env: AgentGuardEnv): AgentGuardError | null {
  if (!env.allowedModels.includes(body.model)) {
    return { code: 'MODEL_NOT_ALLOWED', message: `Model not allowed: ${body.model}` }
  }
  if (body.max_tokens > MAX_TOKENS_CAP) {
    return { code: 'VALIDATION_ERROR', message: `max_tokens must be at most ${MAX_TOKENS_CAP}` }
  }
  if (body.messages.length > MAX_MESSAGES) {
    return { code: 'VALIDATION_ERROR', message: `messages must have at most ${MAX_MESSAGES} entries` }
  }
  if (body.tools?.some(isConfirmActionTool)) {
    return { code: 'tool_not_allowed', message: 'A request may not offer the confirmation tool to the model' }
  }
  if (body.tools && body.tools.length > MAX_TOOLS) {
    return { code: 'VALIDATION_ERROR', message: `tools must have at most ${MAX_TOOLS} entries` }
  }
  if (body.system && body.system.length > MAX_SYSTEM_CHARS) {
    return { code: 'VALIDATION_ERROR', message: `system must be at most ${MAX_SYSTEM_CHARS} characters` }
  }

  const totals: Totals = { textChars: body.system?.length ?? 0, imageCount: 0, imageOversize: false }
  walk(body.messages, totals)
  walk(body.tools ?? [], totals)

  if (totals.imageCount > MAX_IMAGES) {
    return { code: 'VALIDATION_ERROR', message: `at most ${MAX_IMAGES} images are allowed per request` }
  }
  if (totals.imageOversize) {
    return { code: 'VALIDATION_ERROR', message: 'an image exceeds the 5 MB base64 limit' }
  }
  if (totals.textChars > MAX_TEXT_CHARS) {
    return { code: 'VALIDATION_ERROR', message: 'request text exceeds the size limit' }
  }

  return null
}

// filterModelResponse -- applied to a successful Anthropic response before
// agent-proxy relays it. Pure: never touches the network or the DB. Removes
// any tool_use block named confirm_action from content (the model should
// never be offered the tool per checkAgentRequest above, but this is a
// second, independent backstop against one it issues anyway) and, only
// when doing so leaves no tool_use block at all, rewrites a 'tool_use'
// stop_reason to 'end_turn' so a client reading stop_reason does not wait
// on a tool round trip that will never come. A response untouched by this
// filter is returned as-is (same reference), so an unrelated response
// passes through deep-equal.
export interface ModelResponse {
  content?: unknown[]
  stop_reason?: string
  [key: string]: unknown
}

function isToolUseBlock(value: unknown): value is { type: 'tool_use'; name?: unknown } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'tool_use'
}

function isConfirmActionToolUse(value: unknown): boolean {
  return isToolUseBlock(value) && (value as { name?: unknown }).name === 'confirm_action'
}

export function filterModelResponse(body: ModelResponse): ModelResponse {
  if (!Array.isArray(body.content)) return body

  const content = body.content.filter((block) => !isConfirmActionToolUse(block))
  if (content.length === body.content.length) return body

  const stillHasToolUse = content.some(isToolUseBlock)
  const stop_reason = !stillHasToolUse && body.stop_reason === 'tool_use' ? 'end_turn' : body.stop_reason

  return { ...body, content, stop_reason }
}
