import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    storage: {
      from: vi.fn(),
    },
  },
}));

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@shared/lib/logger-instance';
import { supabase } from '@shared/lib/supabase';
import { createTestQueryClient } from '@shared/lib/test-utils';
import {
  ACCEPTED_LOGO_MIME_TYPES,
  MAX_LOGO_UPLOAD_BYTES,
  resizeStoreLogo,
  signStoreLogo,
  storeLogoObjectPath,
  targetLogoDimensions,
  useStoreLogoUrl,
  validateStoreLogoFile,
} from './store-logo-file';

function makeFile(type: string, size: number): File {
  const blob = new Blob([new Uint8Array(size)], { type });
  return new File([blob], 'logo', { type });
}

function mockCreateSignedUrl(result: {
  data: { signedUrl: string } | null;
  error: { message: string } | null;
}): void {
  const fromImpl = { createSignedUrl: vi.fn().mockResolvedValue(result) };
  (supabase.storage.from as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fromImpl);
}

function makeQueryWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('validateStoreLogoFile', () => {
  it('accepts each of the three supported mime types', () => {
    for (const type of ACCEPTED_LOGO_MIME_TYPES) {
      expect(validateStoreLogoFile(makeFile(type, 1024)).ok).toBe(true);
    }
  });

  it('rejects image/heic with VALIDATION_ERROR carrying the offending type', () => {
    const result = validateStoreLogoFile(makeFile('image/heic', 1024));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.detail).toBe('image/heic');
    }
  });

  it('rejects an unsupported type with an empty File.type using the unknownType sentinel, not an empty string', () => {
    const result = validateStoreLogoFile(makeFile('', 1024));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toBe('unknownType');
      expect(result.error.detail).not.toBe('');
    }
  });

  it('accepts image/png at exactly MAX_LOGO_UPLOAD_BYTES', () => {
    const result = validateStoreLogoFile(makeFile('image/png', MAX_LOGO_UPLOAD_BYTES));
    expect(result.ok).toBe(true);
  });

  it('rejects image/png at MAX_LOGO_UPLOAD_BYTES + 1 with a size string formatted to one decimal place', () => {
    const result = validateStoreLogoFile(makeFile('image/png', MAX_LOGO_UPLOAD_BYTES + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PHOTO_TOO_LARGE');
      expect(result.error.detail).toMatch(/^\d+\.\d$/);
    }
  });

  it('is stateless — calling it twice on the same File returns the same verdict', () => {
    const file = makeFile('image/heic', 1024);
    const first = validateStoreLogoFile(file);
    const second = validateStoreLogoFile(file);
    expect(first).toEqual(second);
  });
});

describe('targetLogoDimensions', () => {
  it('does not scale at exactly the 800px threshold', () => {
    expect(targetLogoDimensions({ width: 800, height: 400 })).toEqual({ width: 800, height: 400 });
  });

  it('scales an 801px-wide landscape image to a longest edge of 800 with an integer short edge', () => {
    const result = targetLogoDimensions({ width: 801, height: 400 });
    expect(result.width).toBe(800);
    expect(Number.isInteger(result.height)).toBe(true);
  });

  it('scales a portrait image on its height', () => {
    expect(targetLogoDimensions({ width: 400, height: 1600 })).toEqual({ width: 200, height: 800 });
  });
});

describe('storeLogoObjectPath', () => {
  it('matches store/<uuid>.<ext> with no path segment derived from any file name', () => {
    const path = storeLogoObjectPath('webp');
    expect(path).toMatch(/^store\/[0-9a-f-]{36}\.webp$/);
  });

  it('returns different keys on two consecutive calls', () => {
    const a = storeLogoObjectPath('webp');
    const b = storeLogoObjectPath('webp');
    expect(a).not.toBe(b);
  });
});

describe('resizeStoreLogo', () => {
  it('a file whose declared type is accepted but whose bytes cannot be decoded resolves to an err carrying the declared type, and never rejects as an unhandled promise', async () => {
    const file = makeFile('image/png', 1024); // garbage bytes — not a real PNG
    const result = await resizeStoreLogo(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PHOTO_DECODE_FAILED');
      expect(result.error.detail).toBe('image/png');
    }
  });
});

describe('signStoreLogo', () => {
  it('returns ok(signedUrl) on success', async () => {
    mockCreateSignedUrl({ data: { signedUrl: 'https://signed.example/store-logo.webp' }, error: null });
    const result = await signStoreLogo('store/x.webp');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('https://signed.example/store-logo.webp');
  });

  it('returns err and logs on Storage error', async () => {
    mockCreateSignedUrl({ data: null, error: { message: 'denied' } });
    const result = await signStoreLogo('store/x.webp');
    expect(result.ok).toBe(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('useStoreLogoUrl', () => {
  it('a null path resolves a null url with isLoading false and never calls Storage', async () => {
    const queryClient = createTestQueryClient();
    const wrapper = makeQueryWrapper(queryClient);
    const { result } = renderHook(() => useStoreLogoUrl(null), { wrapper });

    expect(result.current.isLoading).toBe(false);
    await waitFor(() => {
      expect(result.current.url).toBeNull();
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(supabase.storage.from).not.toHaveBeenCalled();
  });

  it('a set path resolves the signed url', async () => {
    mockCreateSignedUrl({ data: { signedUrl: 'https://signed.example/store-logo.webp' }, error: null });
    const queryClient = createTestQueryClient();
    const wrapper = makeQueryWrapper(queryClient);
    const { result } = renderHook(() => useStoreLogoUrl('store/x.webp'), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.url).toBe('https://signed.example/store-logo.webp');
  });
});
