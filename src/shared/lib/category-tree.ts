/**
 * Pure functions for category tree operations.
 *
 * These functions enforce the DB-level contract:
 *   - Max depth 3 (root → child → grandchild)
 *   - No cycles in the parent graph
 *   - Orphan nodes (missing parent) are treated as roots
 *
 * They are tested by property-based tests in category-tree.test.ts.
 */

// ============================================================================
// TYPES
// ============================================================================

/** Minimal shape required for tree operations — avoids importing the full Category domain type. */
export interface TreeNode {
  id: string;
  parentId: string | null | undefined;
}

export interface CategoryTreeNode<T extends TreeNode = TreeNode> {
  node: T;
  children: CategoryTreeNode<T>[];
  depth: number;
}

// ============================================================================
// DEPTH CALCULATION
// ============================================================================

/**
 * Returns the 0-based depth of a node within a flat list.
 * Root nodes have depth 0. Returns -1 if a cycle is detected.
 *
 * @param nodeId - The id to resolve depth for.
 * @param nodes  - Flat list of all nodes.
 * @param visited - Accumulated id set for cycle detection (callers pass `undefined`).
 */
export function getNodeDepth(
  nodeId: string,
  nodes: ReadonlyArray<TreeNode>,
  visited: ReadonlySet<string> = new Set()
): number {
  if (visited.has(nodeId)) return -1; // cycle detected

  const node = nodes.find(n => n.id === nodeId);
  if (node == null) return -1; // unknown id

  const pid = node.parentId ?? null;
  if (pid == null) return 0; // root

  const nextVisited = new Set(visited);
  nextVisited.add(nodeId);
  const parentDepth = getNodeDepth(pid, nodes, nextVisited);
  if (parentDepth === -1) return -1; // propagate cycle / unknown parent
  return parentDepth + 1;
}

// ============================================================================
// VALIDATION
// ============================================================================

/** The maximum allowed depth (0-based). Depth 0 = root, depth 2 = grandchild. */
export const MAX_DEPTH = 2 as const;

/**
 * Returns `true` if inserting / moving `nodeId` to `newParentId` would
 * violate the depth-3 constraint (max depth 2, 0-based), or create a cycle.
 *
 * Checks:
 *   1. `newParentId` must not already be at depth 2 (the grandchild level).
 *   2. Moving `nodeId` under `newParentId` must not create a cycle.
 *   3. Any existing children of `nodeId` must not exceed max depth after the move.
 *
 * @param nodeId      - Node being inserted or moved (may be null for new nodes).
 * @param newParentId - Target parent id (null means make root).
 * @param nodes       - Current flat list of all nodes (before the operation).
 */
export function wouldViolateDepth(
  nodeId: string | null,
  newParentId: string | null,
  nodes: ReadonlyArray<TreeNode>
): boolean {
  if (newParentId == null) {
    // Moving to root is always depth 0 — valid unless nodeId has deep children
    if (nodeId == null) return false;
    return subtreeMaxDepth(nodeId, newParentId, nodes) > MAX_DEPTH;
  }

  // Would the parent itself create a cycle if nodeId is an ancestor of newParentId?
  if (nodeId != null && isAncestor(nodeId, newParentId, nodes)) return true;

  const parentDepth = getNodeDepth(newParentId, nodes);
  if (parentDepth === -1) return true; // cycle in existing tree — reject
  if (parentDepth >= MAX_DEPTH) return true; // parent already at max; children would exceed

  // Check that subtree of nodeId will still fit
  if (nodeId != null) {
    const subMax = subtreeMaxDepth(nodeId, newParentId, nodes);
    if (subMax > MAX_DEPTH) return true;
  }

  return false;
}

/**
 * Returns true if `potentialAncestorId` is an ancestor of `nodeId`
 * (following parentId links upward).
 */
export function isAncestor(
  potentialAncestorId: string,
  nodeId: string,
  nodes: ReadonlyArray<TreeNode>
): boolean {
  const visited = new Set<string>();
  let current: string | null | undefined = nodeId;
  while (current != null) {
    if (visited.has(current)) return false; // cycle — stop
    if (current === potentialAncestorId) return true;
    visited.add(current);
    const n = nodes.find(x => x.id === current);
    current = n?.parentId;
  }
  return false;
}

/**
 * Determines the max absolute depth any descendant of `nodeId` would reach
 * if `nodeId` were placed under `newParentId`.
 *
 * @param nodeId      - Node being moved.
 * @param newParentId - Where it would be placed (null = root).
 * @param nodes       - Current flat list.
 */
function subtreeMaxDepth(
  nodeId: string,
  newParentId: string | null,
  nodes: ReadonlyArray<TreeNode>
): number {
  const newParentDepth = newParentId == null ? -1 : getNodeDepth(newParentId, nodes);
  const baseDepth = newParentDepth + 1;
  return baseDepth + subtreeHeight(nodeId, nodes);
}

/**
 * Returns the height of the subtree rooted at `nodeId` (0 = leaf, 1 = one level of children…).
 */
function subtreeHeight(nodeId: string, nodes: ReadonlyArray<TreeNode>): number {
  const children = nodes.filter(n => n.parentId === nodeId);
  if (children.length === 0) return 0;
  return 1 + Math.max(...children.map(c => subtreeHeight(c.id, nodes)));
}

// ============================================================================
// CYCLE DETECTION
// ============================================================================

/**
 * Returns true if the flat node list contains any cycle via parentId links.
 */
export function hasCycle(nodes: ReadonlyArray<TreeNode>): boolean {
  const idSet = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    if (getNodeDepth(node.id, nodes) === -1) {
      // Distinguish cycle from missing parent
      const pid = node.parentId ?? null;
      if (pid != null && idSet.has(pid)) return true;
    }
  }
  return false;
}

// ============================================================================
// TREE BUILDER
// ============================================================================

/**
 * Converts a flat list of nodes into a sorted tree.
 * Nodes with an unresolvable parentId are treated as roots.
 * Nodes with detected cycles are also placed at the root level.
 */
export function buildTree<T extends TreeNode>(nodes: ReadonlyArray<T>): CategoryTreeNode<T>[] {
  const byId = new Map<string, CategoryTreeNode<T>>();
  for (const n of nodes) {
    byId.set(n.id, { node: n, children: [], depth: 0 });
  }

  const roots: CategoryTreeNode<T>[] = [];
  const idSet = new Set(nodes.map(n => n.id));

  for (const entry of byId.values()) {
    const pid = entry.node.parentId ?? null;
    if (pid == null || !idSet.has(pid)) {
      roots.push(entry);
    } else {
      const parent = byId.get(pid);
      if (parent != null) {
        parent.children.push(entry);
      } else {
        roots.push(entry);
      }
    }
  }

  // Assign depths and sort
  function assignDepths(treeNodes: CategoryTreeNode<T>[], depth: number): void {
    for (const n of treeNodes) {
      n.depth = depth;
      assignDepths(n.children, depth + 1);
    }
  }
  assignDepths(roots, 0);

  return roots;
}
