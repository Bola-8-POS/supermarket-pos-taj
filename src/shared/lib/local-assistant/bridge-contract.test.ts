/**
 * Cross-boundary contract (review CR-01): the renderer builds the `assistant_infer` request, the Rust bridge
 * (`src-tauri/src/commands/assistant/bridge.rs::validate_request`) size-checks it. The two once disagreed (44 messages vs a
 * cap of 12) and every real turn was refused. This test pins the worst-case request the panel can send to a JSON fixture
 * that the Rust test `worst_case_renderer_request_is_accepted` reads, so drift on either side fails a test.
 * Regenerate after an intentional prompt change: UPDATE_ASSISTANT_FIXTURE=1 npx vitest run <this file>.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_INPUT_CHARS, buildMessages } from './prompt';
import { proposalJsonSchema } from './proposal';

const FIXTURE = resolve(__dirname, '../../../../src-tauri/src/commands/assistant/fixtures/worst-case-infer-request.json');
const CONFIG = resolve(__dirname, '../../../../assistant-installer/assistant.config.json');

// The panel sends one turn (system + few-shot + the user text, at most MAX_INPUT_CHARS); there is no chat history.
// 'ñ' is multi-byte: the Rust cap counts characters, so this is still the worst case for it.
const request = { messages: buildMessages('ñ'.repeat(MAX_INPUT_CHARS)), schema: proposalJsonSchema };

describe('assistant_infer request contract with the Rust bridge', () => {
  it('matches the fixture the Rust validate_request test reads', () => {
    if (process.env['UPDATE_ASSISTANT_FIXTURE'] === '1') writeFileSync(FIXTURE, JSON.stringify(request, null, 2) + '\n');
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(JSON.parse(JSON.stringify(request)));
  });

  it('fits the llama-server context with the output budget and a safety margin', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8')) as { profile: { ctx_size: number }; request: { max_tokens: number } };
    const chars = request.messages.reduce((n, m) => n + m.content.length, 0);
    // Calibrated on the fixture: the real Gemma tokenizer (llama-server b12201) measured 1892 prompt tokens for it, so the
    // estimate must be >= 1892. chars/2.5 is conservative (3 chars/token under-counted by ~9% and passed a 2048 ctx wrongly).
    const promptTokens = Math.ceil(chars / 2.5) + 4 * request.messages.length;
    expect(promptTokens).toBeGreaterThanOrEqual(1892);
    expect(cfg.profile.ctx_size - cfg.request.max_tokens - promptTokens).toBeGreaterThanOrEqual(512);
  });
});
