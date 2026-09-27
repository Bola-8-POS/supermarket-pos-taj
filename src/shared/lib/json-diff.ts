/**
 * json-diff.ts — Pure diff utility for JSON objects.
 *
 * Returns a DiffNode[] tree representing differences between two JSON values.
 * No external dependencies. ~60 lines.
 *
 * Usage:
 *   import { diffJson } from '@shared/lib/json-diff';
 *   const nodes = diffJson(before, after);
 */

type DiffStatus = 'added' | 'removed' | 'unchanged' | 'modified';

export interface DiffNode {
  key: string;
  status: DiffStatus;
  before: unknown;
  after: unknown;
  /** Nested children for object/array values */
  children?: DiffNode[];
}

/**
 * Recursively diff two JSON-compatible values.
 * Returns an array of DiffNode describing the differences.
 */
export function diffJson(before: unknown, after: unknown, path = ''): DiffNode[] {
  // Both null / undefined
  if (before === undefined && after === undefined) return [];

  // Primitive or one side is null
  if (
    typeof before !== 'object' ||
    before === null ||
    typeof after !== 'object' ||
    after === null
  ) {
    const status: DiffStatus =
      before === undefined
        ? 'added'
        : after === undefined
          ? 'removed'
          : before === after
            ? 'unchanged'
            : 'modified';
    return [{ key: path, status, before, after }];
  }

  const beforeObj = before as Record<string, unknown>;
  const afterObj = after as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  const nodes: DiffNode[] = [];

  for (const key of allKeys) {
    const bVal = beforeObj[key];
    const aVal = afterObj[key];
    const childPath = path ? `${path}.${key}` : key;

    if (bVal === undefined) {
      nodes.push({ key, status: 'added', before: undefined, after: aVal });
    } else if (aVal === undefined) {
      nodes.push({ key, status: 'removed', before: bVal, after: undefined });
    } else if (
      typeof bVal === 'object' &&
      bVal !== null &&
      typeof aVal === 'object' &&
      aVal !== null &&
      !Array.isArray(bVal) &&
      !Array.isArray(aVal)
    ) {
      const children = diffJson(bVal, aVal, childPath);
      const hasChange = children.some(c => c.status !== 'unchanged');
      nodes.push({
        key,
        status: hasChange ? 'modified' : 'unchanged',
        before: bVal,
        after: aVal,
        children,
      });
    } else {
      const equal = JSON.stringify(bVal) === JSON.stringify(aVal);
      nodes.push({
        key,
        status: equal ? 'unchanged' : 'modified',
        before: bVal,
        after: aVal,
      });
    }
  }

  return nodes;
}
