import { useState } from 'react';
import type { Product } from '@shared/lib/domain';

export function useAddLooseWeightItem() {
  const [product, setProduct] = useState<Product | null>(null);

  return {
    product,
    isOpen: product !== null,
    openFor: (nextProduct: Product) => {
      setProduct(nextProduct);
    },
    close: () => {
      setProduct(null);
    },
  };
}
