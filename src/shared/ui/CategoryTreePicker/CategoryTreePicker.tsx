/**
 * CategoryTreePicker
 *
 * Renders a flat list of categories (with parent_id) as an indented tree.
 * Supports optional controlled single-selection via `value` / `onChange`.
 * Keyboard-accessible: Enter/Space toggles selection, arrow keys move focus.
 *
 * This is a PURE presentation component — it accepts a flat list and renders
 * the tree locally. It does NOT fetch data.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { buildTree, type CategoryTreeNode, type TreeNode } from '@shared/lib/category-tree';

// ============================================================================
// TYPES
// ============================================================================

export interface CategoryPickerItem extends TreeNode {
  id: string;
  parentId: string | null | undefined;
  name: string;
  color: string | undefined;
}

export interface CategoryTreePickerProps {
  /** Flat list of category items (may include parentId for hierarchy). */
  items: CategoryPickerItem[];
  /** Currently selected id (controlled). Pass undefined for uncontrolled. */
  value: string | null | undefined;
  /** Called when user selects / deselects a node. Passes null on deselect. */
  onChange: (id: string | null) => void;
  /** When true the picker is read-only (no click/keyboard interaction). */
  disabled?: boolean;
  /** aria-label for the tree listbox. */
  label?: string;
  /** Optional placeholder when the list is empty. */
  emptyText?: string;
}

// ============================================================================
// INTERNAL TREE NODE COMPONENT
// ============================================================================

interface NodeProps {
  treeNode: CategoryTreeNode<CategoryPickerItem>;
  selectedId: string | null | undefined;
  onSelect: (id: string) => void;
  disabled: boolean;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
  labelId: string;
}

function TreeNodeRow({
  treeNode,
  selectedId,
  onSelect,
  disabled,
  expandedIds,
  onToggleExpand,
  labelId,
}: NodeProps) {
  const { node, children, depth } = treeNode;
  const isSelected = selectedId === node.id;
  const hasChildren = children.length > 0;
  const isExpanded = expandedIds.has(node.id);

  const indentPx = depth * 20;

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!disabled) onSelect(node.id);
    }
    if (e.key === 'ArrowRight' && hasChildren && !isExpanded) {
      e.preventDefault();
      onToggleExpand(node.id);
    }
    if (e.key === 'ArrowLeft' && isExpanded) {
      e.preventDefault();
      onToggleExpand(node.id);
    }
  }

  return (
    <li
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-label={node.name}
    >
      <div className="flex items-center" style={{ paddingLeft: `${String(indentPx)}px` }}>
        {/* Expand/collapse chevron */}
        <button
          type="button"
          aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          className={[
            'mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground',
            'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            !hasChildren ? 'invisible pointer-events-none' : '',
          ].join(' ')}
          onClick={() => {
            if (hasChildren) onToggleExpand(node.id);
          }}
          tabIndex={-1}
        >
          {hasChildren &&
            (isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />)}
        </button>

        {/* Selection button */}
        <button
          type="button"
          id={`${labelId}-node-${node.id}`}
          aria-describedby={labelId}
          disabled={disabled}
          className={[
            'flex flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            isSelected
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-accent hover:text-accent-foreground',
            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          ].join(' ')}
          onClick={() => {
            if (!disabled) onSelect(node.id);
          }}
          onKeyDown={handleKeyDown}
        >
          {node.color != null && (
            <span
              className="size-3 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: node.color }}
              aria-hidden
            />
          )}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {depth === 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {children.length > 0 ? `${String(children.length)} sub` : ''}
            </span>
          )}
        </button>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <ul role="group">
          {children.map(child => (
            <TreeNodeRow
              key={child.node.id}
              treeNode={child}
              selectedId={selectedId}
              onSelect={onSelect}
              disabled={disabled}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              labelId={labelId}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ============================================================================
// PUBLIC COMPONENT
// ============================================================================

export function CategoryTreePicker({
  items,
  value,
  onChange,
  disabled = false,
  label = 'Select category',
  emptyText = 'No categories found.',
}: CategoryTreePickerProps) {
  const labelId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  // Build tree from flat list
  const tree = useMemo(() => buildTree(items), [items]);

  // Expanded state — all nodes start expanded for settings usability
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    return new Set(items.map(item => item.id));
  });

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      onChange(value === id ? null : id);
    },
    [onChange, value]
  );

  if (tree.length === 0) {
    return (
      <p id={labelId} className="text-muted-foreground py-4 text-center text-sm" aria-live="polite">
        {emptyText}
      </p>
    );
  }

  return (
    <div>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <ul
        ref={listRef}
        role="tree"
        aria-labelledby={labelId}
        aria-multiselectable={false}
        className="divide-y rounded-md border"
      >
        {tree.map(node => (
          <TreeNodeRow
            key={node.node.id}
            treeNode={node}
            selectedId={value}
            onSelect={handleSelect}
            disabled={disabled}
            expandedIds={expandedIds}
            onToggleExpand={handleToggleExpand}
            labelId={labelId}
          />
        ))}
      </ul>
    </div>
  );
}
