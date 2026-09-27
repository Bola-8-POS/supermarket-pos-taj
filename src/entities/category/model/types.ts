// src/entities/category/model/types.ts
export type { Category } from '@shared/lib/domain';

// Re-export the tree utilities from shared so consumers of this entity
// don't need to know where the low-level tree functions live.
export {
  buildTree as buildCategoryTree,
  type CategoryTreeNode as CategoryNode,
} from '@shared/lib/category-tree';
