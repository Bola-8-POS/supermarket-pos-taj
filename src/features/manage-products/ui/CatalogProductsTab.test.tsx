import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brand, Category, Product } from '@shared/lib/domain';
import '@shared/lib/i18n';
import { CatalogProductsTab } from './CatalogProductsTab';

const CAT_A: Category = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Biscuits',
  color: '#6366f1',
  sortOrder: 0,
  happyHourStart: null,
  happyHourEnd: null,
  routing: 'NONE',
  parentId: null,
  comboEligible: true,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};
const CAT_B: Category = { ...CAT_A, id: '33333333-3333-4333-8333-333333333333', name: 'Snacks' };
const BRAND: Brand = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Acme',
} as Brand;

function makeProduct(n: number): Product {
  const pad = String(n).padStart(3, '0');
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: `Item ${pad}`,
    categoryId: CAT_A.id,
    basePrice: 10,
    happyHourPrice: null,
    sku: `SKU-${pad}`,
    isActive: true,
    soldByWeight: false,
    imageUrl: null,
    photoPath: n <= 3 ? `photos/${pad}.jpg` : null,
    stock_threshold: null,
    barcode: `89000${pad}`,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: n >= 100 && n <= 110 ? BRAND.id : null,
    weightAmount: null,
    weightUnit: null,
    comboEligible: true,
    isCombo: false,
    comboPriceOverride: null,
    modifiers: [],
  };
}
const PRODUCTS = Array.from({ length: 120 }, (_, i) => makeProduct(i + 1));

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  imageUrls: vi.fn(),
}));

// query results must keep a stable identity across renders, like TanStack Query's
const BRANDS = [BRAND];
const CATEGORIES = [CAT_A, CAT_B];
const NO_MODIFIERS: never[] = [];
vi.mock('@entities/brand', () => ({ useBrands: () => ({ data: BRANDS }) }));
vi.mock('@entities/category', () => ({ useCategories: () => ({ data: CATEGORIES }) }));
vi.mock('@entities/supplier', () => ({
  useProductSupplierIds: () => ({ data: [] }),
  useSuppliers: () => ({ data: [] }),
}));
vi.mock('@entities/product', () => ({
  useModifiers: () => ({ data: NO_MODIFIERS }),
  useProductsForManagement: () => ({ data: PRODUCTS, isLoading: false, resultError: null }),
  useMutationCreateProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMutationDeactivateProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMutationUpdateProduct: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
  useProductImageUrls: (products: Pick<Product, 'photoPath'>[]) => mocks.imageUrls(products),
}));

function renderTab() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <CatalogProductsTab />
    </QueryClientProvider>
  );
}

const rows = () => screen.getAllByTestId('catalog-row-thumb');
const search = () => screen.getByPlaceholderText(/search/i);

beforeEach(() => {
  mocks.mutateAsync.mockReset();
  mocks.mutateAsync.mockResolvedValue({ ok: true, data: PRODUCTS[0] });
  mocks.imageUrls.mockReset();
  mocks.imageUrls.mockImplementation((products: Pick<Product, 'photoPath'>[]) => ({
    urls: new Map(
      products.flatMap(p => (p.photoPath ? [[p.photoPath, `https://x/${p.photoPath}`]] : []))
    ),
    isPending: false,
  }));
});

describe('CatalogProductsTab paging and stability', () => {
  it('renders at most one page of rows', () => {
    renderTab();
    expect(rows()).toHaveLength(50);
  });

  it('searching a product that sits on a later page shows it (name, SKU, barcode)', async () => {
    renderTab();
    for (const [term, name] of [
      ['Item 115', 'Item 115'],
      ['sku-116', 'Item 116'],
      ['89000117', 'Item 117'],
    ] as const) {
      await userEvent.clear(search());
      await userEvent.type(search(), term);
      expect(await within(screen.getByRole('table')).findByDisplayValue(name)).toBeInTheDocument();
      expect(rows()).toHaveLength(1);
    }
  });

  it('typing in one inline name editor does not remount thumbnails', async () => {
    renderTab();
    expect(document.querySelectorAll('img')).toHaveLength(3);
    let added = 0;
    const observer = new MutationObserver(records => {
      for (const r of records) {
        r.addedNodes.forEach(n => {
          if (n instanceof HTMLElement && (n.tagName === 'IMG' || n.querySelector('img'))) added++;
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await userEvent.type(screen.getByDisplayValue('Item 001'), 'abcde');
    observer.disconnect();
    expect(added).toBe(0);
  });

  it('keeps every key typed one by one into the inline name, price and category editors', async () => {
    renderTab();
    await userEvent.type(screen.getByDisplayValue('Item 001'), 'abcde');
    expect(screen.getByDisplayValue('Item 001abcde')).toBeInTheDocument();
    const firstRow = screen.getAllByRole('row')[1];
    if (!firstRow) throw new Error('no row');
    const price = within(firstRow).getAllByRole('textbox')[1];
    if (!price) throw new Error('no price input');
    await userEvent.type(price, '12');
    expect((price as HTMLInputElement).value).toMatch(/12/);
  });

  it('retries a thumbnail after a failed load when its signed url changes', () => {
    const { container, rerender } = renderTab();
    const first = container.querySelector('img');
    if (!first) throw new Error('no img');
    fireEvent.error(first);
    expect(container.querySelectorAll('img')).toHaveLength(2);
    mocks.imageUrls.mockImplementation((products: Pick<Product, 'photoPath'>[]) => ({
      urls: new Map(
        products.flatMap(p => (p.photoPath ? [[p.photoPath, `https://y/${p.photoPath}`]] : []))
      ),
      isPending: false,
    }));
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <CatalogProductsTab />
      </QueryClientProvider>
    );
    expect(container.querySelectorAll('img')).toHaveLength(3);
  });

  it('shows a skeleton, not the no-photo placeholder, while a photo url is not signed yet', () => {
    mocks.imageUrls.mockImplementation(() => ({ urls: new Map(), isPending: false }));
    renderTab();
    expect(screen.getAllByText(/no photo/i, { selector: '.sr-only' })).toHaveLength(47);
  });

  it("signs only the current page's photo paths", async () => {
    renderTab();
    const lastCall = () => {
      const arg = mocks.imageUrls.mock.calls.at(-1)?.[0] as Product[];
      return arg;
    };
    await waitFor(() => {
      expect(lastCall()).toHaveLength(50);
    });
    expect(lastCall().map(p => p.name)).toContain('Item 001');
    await userEvent.click(screen.getByRole('button', { name: /next page/i }));
    await waitFor(() => {
      expect(lastCall().map(p => p.name)).toContain('Item 051');
    });
    expect(lastCall().map(p => p.name)).not.toContain('Item 001');
    expect(lastCall()).toHaveLength(50);
  });

  it('inline name and category edits still commit on blur/change', async () => {
    renderTab();
    const name = screen.getByDisplayValue('Item 001');
    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.blur(name);
    await waitFor(() => {
      expect(mocks.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: PRODUCTS[0]?.id, name: 'Renamed' }),
        expect.anything()
      );
    });
    mocks.mutateAsync.mockClear();
    const firstRow = screen.getAllByRole('row')[1];
    if (!firstRow) throw new Error('no row');
    await userEvent.selectOptions(within(firstRow).getByRole('combobox'), CAT_B.id);
    expect(mocks.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: PRODUCTS[0]?.id, categoryId: CAT_B.id }),
      expect.anything()
    );
  });

  it('a resolved name save keeps a price typed meanwhile, and that price then saves', async () => {
    let finishNameSave: () => void = () => undefined;
    mocks.mutateAsync.mockImplementationOnce(
      (_input: unknown, opts: { onSuccess: (r: unknown) => void }) =>
        new Promise(resolve => {
          finishNameSave = () => {
            const r = { ok: true, data: PRODUCTS[0] };
            opts.onSuccess(r);
            resolve(r);
          };
        })
    );
    renderTab();
    const firstRow = screen.getAllByRole('row')[1];
    if (!firstRow) throw new Error('no row');
    await userEvent.type(screen.getByDisplayValue('Item 001'), 'Z');
    await userEvent.tab();
    const price = within(firstRow).getAllByRole('textbox')[1] as HTMLInputElement;
    await userEvent.type(price, '77');
    finishNameSave();
    await waitFor(() => {
      expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(price.value).toMatch(/77/);
    await userEvent.tab();
    await waitFor(() => {
      expect(mocks.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: PRODUCTS[0]?.id, basePrice: expect.any(Number) }),
        expect.anything()
      );
    });
  });

  it('the brand filter narrows over all rows before paging', async () => {
    renderTab();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /brand/i }), BRAND.id);
    expect(rows()).toHaveLength(11);
  });
});
