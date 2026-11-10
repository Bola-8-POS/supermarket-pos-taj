import { createContext } from 'react';

export interface ProductDraft {
  name: string;
  basePrice: number;
  categoryId: string;
}

/** In-progress inline edits by product id; read inside the cells so a keystroke re-renders them
 * with the new draft while the column definitions stay stable (no thumbnail remount). */
export const ProductDraftsContext = createContext<Readonly<Record<string, ProductDraft>>>({});
