import { createContext } from 'react';

export interface ProductPhotoUrls {
  urls: ReadonlyMap<string, string>;
  isPending: boolean;
}

/** Signed photo URLs for the visible catalog page; read by the thumbnail cell so the photo column
 * can stay a stable column definition (a rebuilt `cell` function remounts every thumbnail). */
export const ProductPhotoUrlsContext = createContext<ProductPhotoUrls>({
  urls: new Map(),
  isPending: false,
});
