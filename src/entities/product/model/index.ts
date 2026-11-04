/**
 * PRODUCT ENTITY - BARREL EXPORT
 */

// Types & Schemas
export { ProductSchema, CategorySchema, ModifierSchema } from './types';

export type { Product, Category, Modifier } from './types';

// State Management
export { useProductStore } from './store';

// Data Fetching
export { useProducts, useProductsForManagement, useCategories, useModifiers, useMutationCreateProduct, useMutationUpdateProduct, useMutationDeactivateProduct, useMutationCreateModifier, useMutationUpdateModifier, useMutationDeleteModifier, invalidateCatalogQueries } from './queries';

export type { CreateProductInput, UpdateProductInput } from './queries';

// Photo resolver (D-14) + batch signer for list surfaces (D-16)
export {
  PRODUCT_PHOTO_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  SIGNED_URL_STALE_TIME_MS,
  signProductPhoto,
  signProductPhotos,
  pickProductImage,
  resolveProductImageUrl,
  useProductImageUrl,
  useProductImageUrls,
} from './resolveProductImage';
