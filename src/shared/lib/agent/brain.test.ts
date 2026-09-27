import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockCallAgentProxy, mockExecuteTool } = vi.hoisted(() => ({
  mockCallAgentProxy: vi.fn(),
  mockExecuteTool: vi.fn().mockResolvedValue({ ok: true, data: { result: 'ok' } }),
}));

vi.mock('@shared/lib/edge-function-contracts', () => ({
  callAgentProxy: mockCallAgentProxy,
}));

vi.mock('./tools/index', () => ({
  allToolDefinitions: [
    {
      name: 'get_menu',
      description: 'Get menu',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'deactivate_product',
      description: 'Deactivate product',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ],
  executeTool: mockExecuteTool,
  DESTRUCTIVE_TOOLS: new Set(['deactivate_product', 'bulk_import_products']),
  WRITE_TOOLS: new Set([
    'open_tab', 'close_tab', 'add_items_to_tab',
    'add_product', 'update_product', 'deactivate_product', 'bulk_import_products',
    'confirm_action',
  ]),
}));

vi.mock('@shared/lib/logger', () => ({
  logger: { warn: vi.fn() },
}));

import { runAgent } from './brain';
import type { Message } from './brain';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function textResponse(text: string): ReturnType<typeof mockCallAgentProxy> {
  return Promise.resolve({
    ok: true,
    data: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  });
}

function toolUseResponse(name: string, id: string, input: Record<string, unknown>) {
  return Promise.resolve({
    ok: true,
    data: {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name, input }],
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_AGENT_MODEL', 'claude-sonnet-4-6');
  });

  it('returns text response when Claude responds with end_turn', async () => {
    mockCallAgentProxy.mockImplementation(() => textResponse('Menu has 10 items.'));
    const result = await runAgent('how many items?', 'manager', []);
    expect(result.text).toBe('Menu has 10 items.');
    expect(result.usedFallback).toBe(false);
    expect(result.awaitingConfirmation).toBe(false);
  });

  it('executes tool and returns final text', async () => {
    mockCallAgentProxy
      .mockImplementationOnce(() => toolUseResponse('get_menu', 'tu-1', {}))
      .mockImplementationOnce(() => textResponse('Hay 5 productos en el menú.'));

    mockExecuteTool.mockResolvedValue({ ok: true, data: [{ name: 'Beer', price: 50 }] });

    const result = await runAgent('¿cuántos productos hay en el menú?', 'manager', []);
    expect(result.toolsExecuted).toContain('get_menu');
    expect(result.text).toBe('Hay 5 productos en el menú.');
    expect(result.usedFallback).toBe(false);
  });

  it('returns awaitingConfirmation=true for destructive tool without confirm', async () => {
    mockCallAgentProxy
      .mockImplementationOnce(() => toolUseResponse('deactivate_product', 'tu-2', { id: 'abc' }))
      .mockImplementationOnce(() => textResponse('Voy a desactivar. Confirma para continuar.'));

    // Return pending action shape — matches real deactivateProduct behavior in menuTools.ts
    mockExecuteTool.mockResolvedValueOnce({
      ok: true,
      data: { pending: true, confirm_token: 'tok-abc', preview: { action: 'deactivate_product', id: 'abc' } },
    });

    const result = await runAgent('deactivate product abc', 'admin', []);
    expect(result.awaitingConfirmation).toBe(true);
    expect(result.pendingConfirmation?.token).toBe('tok-abc');
    expect(result.pendingConfirmation?.preview).toEqual({ action: 'deactivate_product', id: 'abc' });
    // executeTool IS called — it returns the pending shape, not executes the DB write
    expect(mockExecuteTool).toHaveBeenCalledWith('deactivate_product', { id: 'abc' }, expect.any(Object));
  });

  it('executes destructive tool when user message is "confirmar"', async () => {
    mockCallAgentProxy
      .mockImplementationOnce(() => toolUseResponse('deactivate_product', 'tu-3', { id: 'abc' }))
      .mockImplementationOnce(() => textResponse('Producto desactivado.'));

    mockExecuteTool.mockResolvedValue({ ok: true, data: { id: 'abc' } });

    const result = await runAgent('confirmar', 'admin', [
      { role: 'user', content: 'deactivate product abc' },
      { role: 'assistant', content: 'Voy a desactivar el producto. Responde confirmar.' },
    ]);

    expect(result.awaitingConfirmation).toBe(false);
    expect(result.toolsExecuted).toContain('deactivate_product');
    expect(mockExecuteTool).toHaveBeenCalledWith('deactivate_product', { id: 'abc' }, expect.any(Object));
  });

  it('detects Spanish and includes lang instruction in system prompt', async () => {
    let capturedSystem = '';
    mockCallAgentProxy.mockImplementation((params: { system?: string }) => {
      capturedSystem = params.system ?? '';
      return textResponse('Respuesta en español.');
    });

    await runAgent('¿cuántos productos hay en el menú?', 'bartender', []);
    expect(capturedSystem).toContain('Spanish');
  });

  it('falls back to Ollama after 2 Claude failures', async () => {
    mockCallAgentProxy.mockRejectedValue(new Error('network error'));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'Ollama fallback response' } }),
    } as Response);

    const result = await runAgent('test', 'bartender', []);
    expect(result.usedFallback).toBe(true);
    expect(result.text).toBe('Ollama fallback response');
    fetchSpy.mockRestore();
  });

  it('returns error message when both Claude and Ollama fail', async () => {
    mockCallAgentProxy.mockRejectedValue(new Error('network error'));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Ollama not running'));

    const result = await runAgent('test', 'bartender', []);
    expect(result.usedFallback).toBe(true);
    expect(result.text).toMatch(/unavailable|disponible/i);
  });

  it('refuses a model-issued confirm_action instead of executing it', async () => {
    mockCallAgentProxy
      .mockImplementationOnce(() => toolUseResponse('confirm_action', 'tu-4', { token: 'tok-xyz' }))
      .mockImplementationOnce(() => textResponse('done'));

    const result = await runAgent('please confirm that for me', 'admin', []);

    expect(mockExecuteTool).not.toHaveBeenCalledWith(
      'confirm_action',
      expect.anything(),
      expect.anything()
    );
    expect(result.toolsExecuted).toContain('confirm_action');
  });

  it('trims a long history so one full turn stays under the proxy message cap, starting on a user message', async () => {
    const longHistory: Message[] = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${String(i)}`,
    }));

    let capturedMessages: Array<{ role: string; content: unknown }> = [];
    mockCallAgentProxy.mockImplementation(
      (params: { messages: Array<{ role: string; content: unknown }> }) => {
        capturedMessages = params.messages;
        return textResponse('ok');
      }
    );

    await runAgent('one more message', 'manager', longHistory);

    expect(capturedMessages.length).toBeLessThanOrEqual(60);
    expect(capturedMessages[0]?.role).toBe('user');
  });

  it('stops retrying and returns an error once a write tool has run in the attempt', async () => {
    mockCallAgentProxy
      .mockImplementationOnce(() => toolUseResponse('open_tab', 'tu-1', { customer_name: 'Test' }))
      .mockRejectedValueOnce(new Error('network error'));

    mockExecuteTool.mockResolvedValueOnce({ ok: true, data: { id: 'tab-1' } });

    const result = await runAgent('open a tab for test', 'admin', []);

    expect(mockCallAgentProxy).toHaveBeenCalledTimes(2);
    expect(result.usedFallback).toBe(false);
    expect(result.toolsExecuted).toContain('open_tab');
    expect(result.text).toMatch(/went wrong/i);
  });

  it('surfaces a rate-limit refusal directly instead of retrying or falling back to Ollama', async () => {
    mockCallAgentProxy.mockResolvedValue({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in 30s.' },
    });

    const result = await runAgent('hello', 'admin', []);

    expect(mockCallAgentProxy).toHaveBeenCalledTimes(1);
    expect(result.usedFallback).toBe(false);
    expect(result.text).toBe('Too many requests. Try again in 30s.');
  });
});
