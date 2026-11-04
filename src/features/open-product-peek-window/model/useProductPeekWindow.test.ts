import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetByLabel = vi.fn();
const mockWebviewWindowCtor = vi.fn();
const mockEmit = vi.fn().mockResolvedValue(undefined);

vi.mock('@tauri-apps/api/webviewWindow', () => {
  function WebviewWindow(this: unknown, ...args: unknown[]) {
    mockWebviewWindowCtor(...args);
  }
  WebviewWindow.getByLabel = mockGetByLabel;
  return { WebviewWindow };
});

vi.mock('@tauri-apps/api/event', () => ({
  emit: mockEmit,
}));

describe('ensurePeekWindowShown', () => {
  beforeEach(() => {
    mockGetByLabel.mockReset();
    mockWebviewWindowCtor.mockReset();
    mockEmit.mockReset().mockResolvedValue(undefined);
    // ensurePeekWindowShown no-ops outside a real Tauri runtime (isTauri()
    // checks this global) — real Tauri injects it, and so does the peek-window
    // E2E mock; set it here too so these unit tests exercise the real call path.
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('constructs exactly one WebviewWindow when none exists yet, and never emits', async () => {
    mockGetByLabel.mockResolvedValue(null);
    const { ensurePeekWindowShown } = await import('./useProductPeekWindow');

    await ensurePeekWindowShown('7501234567890');

    expect(mockWebviewWindowCtor).toHaveBeenCalledTimes(1);
    const [label, options] = mockWebviewWindowCtor.mock.calls[0] as [string, Record<string, unknown>];
    expect(label).toBe('peek');
    expect(options).toMatchObject({
      url: '/?window=peek&barcode=7501234567890',
      width: 480,
      height: 720,
      minWidth: 400,
      minHeight: 600,
      resizable: true,
      center: true,
    });
    expect(typeof options.title).toBe('string');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('URL-encodes a barcode containing special characters', async () => {
    mockGetByLabel.mockResolvedValue(null);
    const { ensurePeekWindowShown } = await import('./useProductPeekWindow');

    await ensurePeekWindowShown('123 456');

    const [, options] = mockWebviewWindowCtor.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.url).toBe('/?window=peek&barcode=123%20456');
  });

  it('reuses an existing window via show/setFocus/emit instead of constructing a second one', async () => {
    const existing = {
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    };
    mockGetByLabel.mockResolvedValue(existing);
    const { ensurePeekWindowShown, PEEK_WINDOW_REFRESH_EVENT } = await import(
      './useProductPeekWindow'
    );

    await ensurePeekWindowShown('code2');

    expect(existing.show).toHaveBeenCalledTimes(1);
    expect(existing.setFocus).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(PEEK_WINDOW_REFRESH_EVENT, { code: 'code2' });
    expect(mockWebviewWindowCtor).not.toHaveBeenCalled();
  });
});
