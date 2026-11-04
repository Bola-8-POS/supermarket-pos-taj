/**
 * Promotion entity public API.
 *
 * Import from here: `import { usePromotions, evaluateBestPromotion } from '@entities/promotion'`
 *
 * FSD boundary: features and widgets may import from this index only.
 * Deep imports into model/ are NOT allowed from outside this entity.
 */

export {
  usePromotions,
  useMutationCreatePromotion,
  useMutationUpdatePromotion,
  useMutationDeletePromotion,
} from './model/queries';

export {
  evaluateBestPromotion,
  round2,
  getStoreLocalDowAndTime,
  isPromotionLiveAt,
  weightedLinePrice,
  type PromotionPricingProduct,
  type PromotionMatch,
} from './model/promotion-pricing';

export {
  resolveProductPromotion,
  type PromotionPricingSettings,
} from './model/resolve-product-promotion';

export {
  evaluateCombos,
  isProductComboEligible,
  isCategoryChainEligible,
  getCategoryChain,
  type ComboCartLine,
  type ComboUnitAllocation,
  type ComboApplication,
  type ComboEvaluation,
  type ComboCategoryLookup,
} from './model/combo-pricing';

export type {
  Promotion,
  PromotionCreate,
  PromotionUpdate,
  PromotionTarget,
  PromotionTargetInput,
} from './model/types';
