/**
 * Category entity public API.
 *
 * Import from here: `import { useCategories } from '@entities/category'`
 *
 * FSD boundary: features and widgets may import from this index only.
 * Deep imports into model/ are NOT allowed from outside this entity.
 */

export { useCategories, useMutationCreateCategory, useMutationUpdateCategory } from './model';

export type { Category } from './model';
