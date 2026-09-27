import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockCallAgentProxy } = vi.hoisted(() => ({
  mockCallAgentProxy: vi.fn(),
}));

vi.mock('@shared/lib/edge-function-contracts', () => ({
  callAgentProxy: mockCallAgentProxy,
}));

vi.mock('@shared/lib/logger', () => ({
  logger: { warn: vi.fn() },
}));

import { extractProductsFromImage, extractProductsFromText } from './vision';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('extractProductsFromText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_AGENT_MODEL', 'claude-sonnet-4-6');
  });

  it('calls callAgentProxy with model/max_tokens/messages and parses a successful response', async () => {
    mockCallAgentProxy.mockResolvedValue({
      ok: true,
      data: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '[{"name":"Widget","price":9.99}]' }],
      },
    });

    const result = await extractProductsFromText('some invoice text');

    expect(mockCallAgentProxy).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: expect.stringContaining('some invoice text') as string }],
    });
    expect(result).toEqual([{ name: 'Widget', price: 9.99 }]);
  });

  it('returns [] when callAgentProxy resolves to an error Result', async () => {
    mockCallAgentProxy.mockResolvedValue({
      ok: false,
      error: { code: 'AGENT_ERROR', message: 'boom' },
    });

    const result = await extractProductsFromText('some invoice text');

    expect(result).toEqual([]);
  });
});

describe('extractProductsFromImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_AGENT_MODEL', 'claude-sonnet-4-6');
  });

  it('calls callAgentProxy with an image block and a text block, and parses a successful response', async () => {
    mockCallAgentProxy.mockResolvedValue({
      ok: true,
      data: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '[{"name":"Widget","price":9.99}]' }],
      },
    });

    const result = await extractProductsFromImage('base64data', 'image/png');

    expect(mockCallAgentProxy).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64data' } },
            { type: 'text', text: expect.stringContaining('Extract') as string },
          ],
        },
      ],
    });
    expect(result).toEqual([{ name: 'Widget', price: 9.99 }]);
  });

  it('returns [] when callAgentProxy resolves to an error Result', async () => {
    mockCallAgentProxy.mockResolvedValue({
      ok: false,
      error: { code: 'AGENT_ERROR', message: 'boom' },
    });

    const result = await extractProductsFromImage('base64data', 'image/png');

    expect(result).toEqual([]);
  });
});
