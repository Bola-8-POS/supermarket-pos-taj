export {
  useProducts,
  useProductsForManagement,
  useCategories,
  useModifiers,
  useMutationCreateProduct,
  useMutationUpdateProduct,
  useMutationDeactivateProduct,
  useMutationCreateModifier,
  useMutationUpdateModifier,
  useMutationDeleteModifier,
  invalidateCatalogQueries,
} from './model';

export type { CreateProductInput, UpdateProductInput } from './model';

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
} from './model';
export { ProductLookupInput } from './ui/ProductLookupInput';
export { findProductByLookup } from './model/product-lookup';
export type { ProductLookupInputProps } from './ui/ProductLookupInput';
