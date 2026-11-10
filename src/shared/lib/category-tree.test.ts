/**
 * Property-based tests (fast-check) for category-tree pure functions.
 *
 * P1 contract (mirrors DB trigger):
 *   - No cycles allowed in a valid tree
 *   - Depth ≤ 3 levels (0-indexed max: 2)
 *   - wouldViolateDepth rejects any operation that would break the constraint
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  buildTree,
  getNodeDepth,
  hasCycle,
  isAncestor,
  wouldViolateDepth,
  type TreeNode,
} from './category-tree';

// ============================================================================
// ARBITRARIES
// ============================================================================

/**
 * Generates a flat list of nodes that form a VALID tree (no cycles, depth ≤ MAX_DEPTH).
 * Strategy: build level by level.
 */
const arbValidTree = fc
  .integer({ min: 1, max: 50 })
  .chain(totalNodes =>
    fc.tuple(
      // Generate unique ids
      fc.uniqueArray(fc.uuid(), { minLength: totalNodes, maxLength: totalNodes }),
      // For each node, pick a depth 0..MAX_DEPTH
      fc.array(fc.integer({ min: 0, max: MAX_DEPTH }), {
        minLength: totalNodes,
        maxLength: totalNodes,
      })
    )
  )
  .map(([ids, depths]): TreeNode[] => {
    // Build a valid tree by ensuring each node's parent is at depth-1
    const nodes: TreeNode[] = [];
    const byDepth: string[][] = [[], [], []];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const desiredDepth = depths[i]!;

      let actualDepth = 0;
      let parentId: string | null = null;

      // Try to place at desired depth; fall back to a valid depth if no parents available
      for (let d = Math.min(desiredDepth, MAX_DEPTH); d >= 0; d--) {
        if (d === 0) {
          actualDepth = 0;
          parentId = null;
          break;
        }
        const potentialParents = byDepth[d - 1];
        if (potentialParents && potentialParents.length > 0) {
          // pick first available parent (deterministic within the fc run)
          parentId = potentialParents[0]!;
          actualDepth = d;
          break;
        }
      }

      const container = byDepth[actualDepth];
      if (container) container.push(id);
      nodes.push({ id, parentId });
    }

    return nodes;
  });

/**
 * Generates an arbitrary flat list of nodes — may have cycles or deep chains.
 */
const arbNodeList = (maxNodes = 20) =>
  fc
    .integer({ min: 1, max: maxNodes })
    .chain(n =>
      fc.tuple(
        fc.uniqueArray(fc.uuid(), { minLength: n, maxLength: n }),
        fc.array(fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: null }), {
          minLength: n,
          maxLength: n,
        })
      )
    )
    .map(([ids, parentIdxs]): TreeNode[] =>
      ids.map((id, i) => {
        const pidx = parentIdxs[i];
        const parentId = pidx == null ? null : (ids[pidx] ?? null);
        return { id, parentId: parentId === id ? null : parentId };
      })
    );

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('getNodeDepth', () => {
  it('root node has depth 0', () => {
    const nodes: TreeNode[] = [{ id: 'a', parentId: null }];
    expect(getNodeDepth('a', nodes)).toBe(0);
  });

  it('child of root has depth 1', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
    ];
    expect(getNodeDepth('b', nodes)).toBe(1);
  });

  it('grandchild has depth 2', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' },
    ];
    expect(getNodeDepth('c', nodes)).toBe(2);
  });

  it('returns -1 for a direct cycle', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect(getNodeDepth('a', nodes)).toBe(-1);
  });

  it('returns -1 for unknown node', () => {
    const nodes: TreeNode[] = [{ id: 'a', parentId: null }];
    expect(getNodeDepth('z', nodes)).toBe(-1);
  });
});

describe('isAncestor', () => {
  it('parent is an ancestor of child', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
    ];
    expect(isAncestor('a', 'b', nodes)).toBe(true);
  });

  it('grandparent is an ancestor', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' },
    ];
    expect(isAncestor('a', 'c', nodes)).toBe(true);
  });

  it('child is NOT ancestor of parent', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
    ];
    expect(isAncestor('b', 'a', nodes)).toBe(false);
  });

  it('sibling is not an ancestor', () => {
    const nodes: TreeNode[] = [
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root' },
      { id: 'b', parentId: 'root' },
    ];
    expect(isAncestor('a', 'b', nodes)).toBe(false);
  });

  it('terminates without infinite loop on a cycle (visited-set guard)', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    // In a cycle a↔b, walking up from 'b' reaches 'a' on the first step.
    // The function must terminate (no stack overflow) and return a boolean.
    const result = isAncestor('a', 'b', nodes);
    expect(typeof result).toBe('boolean');
  });
});

describe('wouldViolateDepth', () => {
  it('root-level insert is always valid', () => {
    const nodes: TreeNode[] = [{ id: 'a', parentId: null }];
    expect(wouldViolateDepth(null, null, nodes)).toBe(false);
  });

  it('child of root (depth 1) is valid', () => {
    const nodes: TreeNode[] = [{ id: 'root', parentId: null }];
    expect(wouldViolateDepth(null, 'root', nodes)).toBe(false);
  });

  it('grandchild (depth 2) is valid', () => {
    const nodes: TreeNode[] = [
      { id: 'root', parentId: null },
      { id: 'child', parentId: 'root' },
    ];
    expect(wouldViolateDepth(null, 'child', nodes)).toBe(false);
  });

  it('4th level (depth 3) is rejected', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' },
    ];
    expect(wouldViolateDepth(null, 'c', nodes)).toBe(true);
  });

  it('rejects moving a node to its own descendant (cycle)', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
    ];
    // Moving 'a' under 'b' would create a cycle
    expect(wouldViolateDepth('a', 'b', nodes)).toBe(true);
  });

  it('rejects move that would push existing children beyond depth limit', () => {
    const nodes: TreeNode[] = [
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root' },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' }, // grandchild of 'a'
      { id: 'other', parentId: null },
    ];
    // Moving 'a' (which has depth-2 child 'c') under 'other' → 'c' would be at depth 3
    expect(wouldViolateDepth('a', 'other', nodes)).toBe(true);
  });
});

describe('hasCycle', () => {
  it('returns false for a valid flat list', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
    ];
    expect(hasCycle(nodes)).toBe(false);
  });

  it('returns true for a direct cycle', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect(hasCycle(nodes)).toBe(true);
  });

  it('returns false when parentId references missing node', () => {
    const nodes: TreeNode[] = [{ id: 'a', parentId: 'nonexistent' }];
    // 'nonexistent' is not in the list — treated as orphan, no cycle
    expect(hasCycle(nodes)).toBe(false);
  });
});

describe('buildTree', () => {
  it('places root-level nodes at depth 0', () => {
    const nodes: TreeNode[] = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: null },
    ];
    const tree = buildTree(nodes);
    expect(tree).toHaveLength(2);
    expect(tree.every(n => n.depth === 0)).toBe(true);
  });

  it('places children at depth 1', () => {
    const nodes: TreeNode[] = [
      { id: 'root', parentId: null },
      { id: 'child', parentId: 'root' },
    ];
    const tree = buildTree(nodes);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.depth).toBe(1);
  });

  it('orphans are treated as roots', () => {
    const nodes: TreeNode[] = [{ id: 'orphan', parentId: 'nonexistent' }];
    const tree = buildTree(nodes);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.depth).toBe(0);
  });
});

// ============================================================================
// PROPERTY TESTS
// ============================================================================

describe('P1 — property: valid tree never has depth > MAX_DEPTH', () => {
  it('all nodes in a valid tree have depth ≤ MAX_DEPTH', () => {
    fc.assert(
      fc.property(arbValidTree, nodes => {
        for (const node of nodes) {
          const depth = getNodeDepth(node.id, nodes);
          if (depth === -1) {
            // A -1 here means a cycle crept in via our arbitrary — that would be a bug in the arbitrary
            expect(depth).not.toBe(-1);
            return;
          }
          expect(depth).toBeLessThanOrEqual(MAX_DEPTH);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('buildTree depth assignments match getNodeDepth', () => {
    fc.assert(
      fc.property(arbValidTree, nodes => {
        const tree = buildTree(nodes);

        function collectAll(
          treeNodes: ReturnType<typeof buildTree>
        ): { id: string; treeDepth: number }[] {
          return treeNodes.flatMap(n => [
            { id: n.node.id, treeDepth: n.depth },
            ...collectAll(n.children),
          ]);
        }

        const flat = collectAll(tree);
        for (const { id, treeDepth } of flat) {
          const calcDepth = getNodeDepth(id, nodes);
          expect(treeDepth).toBe(calcDepth);
        }
      }),
      { numRuns: 200 }
    );
  });
});

describe('P1 — property: hasCycle vs valid tree', () => {
  it('valid trees have no cycle', () => {
    fc.assert(
      fc.property(arbValidTree, nodes => {
        expect(hasCycle(nodes)).toBe(false);
      }),
      { numRuns: 200 }
    );
  });
});

describe('P1 — property: wouldViolateDepth guards', () => {
  it('inserting at depth > MAX_DEPTH is always rejected', () => {
    // Build a chain of MAX_DEPTH+1 nodes, then try to add one more
    fc.assert(
      fc.property(fc.tuple(fc.uuid(), fc.uuid(), fc.uuid()), ([a, b, c]) => {
        const chain: TreeNode[] = [
          { id: a, parentId: null },
          { id: b, parentId: a },
          { id: c, parentId: b },
        ];
        // c is at depth 2 (MAX_DEPTH). Inserting under c → depth 3 → should be rejected.
        expect(wouldViolateDepth(null, c, chain)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('inserting at root level is never rejected for new nodes', () => {
    fc.assert(
      fc.property(arbNodeList(30), nodes => {
        // null nodeId = new node, null parentId = root
        const result = wouldViolateDepth(null, null, nodes);
        expect(result).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('moving a node under its own descendant is always rejected', () => {
    fc.assert(
      fc.property(arbValidTree, nodes => {
        // Pick any non-root node and try to move its root ancestor to be its child
        const nonRoot = nodes.find(n => n.parentId != null);
        if (!nonRoot) return; // skip trivial case

        // Move the node's parent under the node itself — this must be rejected
        const pid = nonRoot.parentId!;
        const violated = wouldViolateDepth(pid, nonRoot.id, nodes);
        expect(violated).toBe(true);
      }),
      { numRuns: 200 }
    );
  });
});

describe('P1 — stress: up to 1000 nodes', () => {
  it('getNodeDepth handles 1000-node valid trees within MAX_DEPTH', () => {
    // Build a wide tree: 333 roots, each with 1 child, each child with 1 grandchild
    const nodes: TreeNode[] = [];
    for (let i = 0; i < 333; i++) {
      const rootId = `root-${i}`;
      const childId = `child-${i}`;
      const grandId = `grand-${i}`;
      nodes.push({ id: rootId, parentId: null });
      nodes.push({ id: childId, parentId: rootId });
      nodes.push({ id: grandId, parentId: childId });
    }
    // 999 nodes total — push one more root
    nodes.push({ id: 'extra-root', parentId: null });

    expect(nodes.length).toBe(1000);
    expect(hasCycle(nodes)).toBe(false);
    for (const n of nodes) {
      const depth = getNodeDepth(n.id, nodes);
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(MAX_DEPTH);
    }
  });
});
