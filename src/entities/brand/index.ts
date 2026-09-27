/**
 * Brand entity public API.
 *
 * Import from here: `import { useBrands } from '@entities/brand'`
 *
 * FSD boundary: features and widgets may import from this index only.
 * Deep imports into model/ are NOT allowed from outside this entity.
 */

export {
  useBrands,
  useMutationCreateBrand,
  useMutationUpdateBrand,
  useMutationDeleteBrand,
} from './model';

export type { Brand, BrandCreate, BrandUpdate } from './model';
