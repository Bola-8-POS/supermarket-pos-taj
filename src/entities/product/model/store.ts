import { create } from 'zustand';
import type { Product, Category, Modifier } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';

interface ProductState {
  products: Product[];
  categories: Category[];
  modifiers: Modifier[];
  lastFetchedAt: Date | null;
}

interface ProductActions {
  /** Replaces the products list; called by TanStack Query on success. */
  setProducts: (products: Product[]) => void;

  /** Replaces the categories list; called by TanStack Query on success. */
  setCategories: (categories: Category[]) => void;

  /** Replaces the modifiers list; called by TanStack Query on success. */
  setModifiers: (modifiers: Modifier[]) => void;
}

type ProductStore = ProductState & ProductActions;

/** Read-only in POS — no mutations. Server state is owned by TanStack Query. */
export const useProductStore = create<ProductStore>(set => ({
  products: [],
  categories: [],
  modifiers: [],
  lastFetchedAt: null,

  setProducts: products => {
    logger.info('products.loaded', { count: products.length });
    set({ products, lastFetchedAt: new Date() });
  },

  setCategories: categories => {
    logger.info('categories.loaded', { count: categories.length });
    set({ categories });
  },

  setModifiers: modifiers => {
    logger.info('modifiers.loaded', { count: modifiers.length });
    set({ modifiers });
  },
}));
