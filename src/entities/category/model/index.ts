/**
 * CATEGORY ENTITY MODEL - BARREL EXPORT
 */

// Types & Schemas
export { buildCategoryTree } from './types';
export type { Category, CategoryNode } from './types';

// Query key (for external invalidation if needed)

// Data Fetching & Mutations
export { useCategories, useMutationCreateCategory, useMutationUpdateCategory } from './queries';
