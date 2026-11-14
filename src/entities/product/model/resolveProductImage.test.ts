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
  pickProductImage,
  resolveProductImageUrl,
  signProductPhoto,
  signProductPhotos,
  useProductImageUrls,
} from './resolveProductImage';

function mockCreateSignedUrl(result: { data: { signedUrl: string } | null; error: { message: string } | null }): void {
  const fromImpl = { createSignedUrl: vi.fn().mockResolvedValue(result) };
  (supabase.storage.from as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fromImpl);
}

function mockCreateSignedUrls(result: {
  data: { path: string | null; error: string | null; signedUrl: string | null }[] | null;
  error: { message: string } | null;
}): ReturnType<typeof vi.fn> {
  const createSignedUrls = vi.fn().mockResolvedValue(result);
  const fromImpl = { createSignedUrls };
  (supabase.storage.from as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fromImpl);
  return createSignedUrls;
}

function makeQueryWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('pickProductImage', () => {
  it('prefers a resolved signed URL over imageUrl', () => {
    expect(pickProductImage({ signedUrl: 'https://signed', imageUrl: 'https://legacy' })).toBe(
      'https://signed'
    );
  });

  it('falls back to imageUrl when there is no signed URL', () => {
    expect(pickProductImage({ signedUrl: null, imageUrl: 'https://legacy' })).toBe(
      'https://legacy'
    );
  });

  it('returns null when both are null', () => {
    expect(pickProductImage({ signedUrl: null, imageUrl: null })).toBeNull();
  });
});

describe('resolveProductImageUrl', () => {
  it('photoPath set + imageUrl set: resolves to the signed URL derived from photoPath', async () => {
    mockCreateSignedUrl({ data: { signedUrl: 'https://signed.example/photo.webp' }, error: null });
    const url = await resolveProductImageUrl({
      photoPath: 'products/p1/abc.webp',
      imageUrl: 'https://legacy.example/old.jpg',
    });
    expect(url).toBe('https://signed.example/photo.webp');
  });

  it('photoPath null + imageUrl set: returns imageUrl unchanged', async () => {
    const url = await resolveProductImageUrl({ photoPath: null, imageUrl: 'https://legacy.example/old.jpg' });
    expect(url).toBe('https://legacy.example/old.jpg');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(supabase.storage.from).not.toHaveBeenCalled();
  });

  it('both null: returns null', async () => {
    const url = await resolveProductImageUrl({ photoPath: null, imageUrl: null });
    expect(url).toBeNull();
  });

  it('photoPath set but signer errors: falls through to imageUrl', async () => {
    mockCreateSignedUrl({ data: null, error: { message: 'not found' } });
    const url = await resolveProductImageUrl({
      photoPath: 'products/p1/missing.webp',
      imageUrl: 'https://legacy.example/old.jpg',
    });
    expect(url).toBe('https://legacy.example/old.jpg');
  });

  it('photoPath set but signer errors and imageUrl is also null: returns null, never a broken path string', async () => {
    mockCreateSignedUrl({ data: null, error: { message: 'not found' } });
    const url = await resolveProductImageUrl({ photoPath: 'products/p1/missing.webp', imageUrl: null });
    expect(url).toBeNull();
  });
});

describe('signProductPhoto', () => {
  it('returns ok(signedUrl) on success', async () => {
    mockCreateSignedUrl({ data: { signedUrl: 'https://signed.example/x.webp' }, error: null });
    const result = await signProductPhoto('products/p1/x.webp');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('https://signed.example/x.webp');
  });

  it('returns err and logs on Storage error', async () => {
    mockCreateSignedUrl({ data: null, error: { message: 'denied' } });
    const result = await signProductPhoto('products/p1/x.webp');
    expect(result.ok).toBe(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('signProductPhotos', () => {
  it('short-circuits on an empty input: zero signing requests, resolves an empty map', async () => {
    const createSignedUrls = mockCreateSignedUrls({ data: [], error: null });
    const map = await signProductPhotos([]);
    expect(map.size).toBe(0);
    expect(createSignedUrls).not.toHaveBeenCalled();
  });

  it('performs exactly one signing request for two paths and resolves both', async () => {
    const createSignedUrls = mockCreateSignedUrls({
      data: [
        { path: 'products/p1/a.webp', error: null, signedUrl: 'https://signed/a' },
        { path: 'products/p2/b.webp', error: null, signedUrl: 'https://signed/b' },
      ],
      error: null,
    });
    const map = await signProductPhotos(['products/p1/a.webp', 'products/p2/b.webp']);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(map.get('products/p1/a.webp')).toBe('https://signed/a');
    expect(map.get('products/p2/b.webp')).toBe('https://signed/b');
  });

  it('requests a duplicate path once and returns it once in the map', async () => {
    const createSignedUrls = mockCreateSignedUrls({
      data: [{ path: 'products/p1/a.webp', error: null, signedUrl: 'https://signed/a' }],
      error: null,
    });
    const map = await signProductPhotos(['products/p1/a.webp', 'products/p1/a.webp']);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    const [requestedPaths] = createSignedUrls.mock.calls[0] as [string[], number];
    expect(requestedPaths).toEqual(['products/p1/a.webp']);
    expect(map.size).toBe(1);
  });

  it('omits a row carrying a per-row error while keeping its siblings', async () => {
    mockCreateSignedUrls({
      data: [
        { path: 'products/p1/a.webp', error: 'not found', signedUrl: null },
        { path: 'products/p2/b.webp', error: null, signedUrl: 'https://signed/b' },
      ],
      error: null,
    });
    const map = await signProductPhotos(['products/p1/a.webp', 'products/p2/b.webp']);
    expect(map.has('products/p1/a.webp')).toBe(false);
    expect(map.get('products/p2/b.webp')).toBe('https://signed/b');
  });

  it('resolves an empty map and logs on a top-level signing failure, never throwing', async () => {
    mockCreateSignedUrls({ data: null, error: { message: 'service unavailable' } });
    const map = await signProductPhotos(['products/p1/a.webp']);
    expect(map.size).toBe(0);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(logger.error).toHaveBeenCalled();
  });

  it('resolves an empty map and logs when the signer call itself rejects, never throwing', async () => {
    const createSignedUrls = vi.fn().mockRejectedValue(new Error('network down'));
    (supabase.storage.from as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ createSignedUrls });
    await expect(signProductPhotos(['products/p1/a.webp'])).resolves.toEqual(new Map());
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('useProductImageUrls', () => {
  it('keys the batch query by the sorted, de-duplicated path list — reordered rows share one cache entry', async () => {
    mockCreateSignedUrls({
      data: [
        { path: 'products/p1/a.webp', error: null, signedUrl: 'https://signed/a' },
        { path: 'products/p2/b.webp', error: null, signedUrl: 'https://signed/b' },
      ],
      error: null,
    });
    const queryClient = createTestQueryClient();
    const wrapper = makeQueryWrapper(queryClient);
    const productsAB = [{ photoPath: 'products/p1/a.webp' }, { photoPath: 'products/p2/b.webp' }];
    const productsBA = [{ photoPath: 'products/p2/b.webp' }, { photoPath: 'products/p1/a.webp' }];

    const { result, rerender } = renderHook(
      ({ products }: { products: { photoPath: string | null }[] }) => useProductImageUrls(products),
      { wrapper, initialProps: { products: productsAB } }
    );
    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    rerender({ products: productsBA });
    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
    expect(result.current.urls.get('products/p1/a.webp')).toBe('https://signed/a');
  });

  it('does not sign when every product has no photo path', () => {
    const createSignedUrls = mockCreateSignedUrls({ data: [], error: null });
    const queryClient = createTestQueryClient();
    const wrapper = makeQueryWrapper(queryClient);
    const { result } = renderHook(() => useProductImageUrls([{ photoPath: null }, { photoPath: null }]), {
      wrapper,
    });
    expect(result.current.isPending).toBe(false);
    expect(result.current.urls.size).toBe(0);
    expect(createSignedUrls).not.toHaveBeenCalled();
  });
});
