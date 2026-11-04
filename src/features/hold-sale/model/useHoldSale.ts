import { useCartStore } from '@entities/tab/model/cartStore';

export function useHoldSale() {
  const heldCart = useCartStore(state => state.heldCart);
  const holdCart = useCartStore(state => state.holdCart);
  const resumeHeld = useCartStore(state => state.resumeHeld);
  const discardHeld = useCartStore(state => state.discardHeld);

  return { heldCart, holdCart, resumeHeld, discardHeld, isHeld: heldCart !== null };
}
