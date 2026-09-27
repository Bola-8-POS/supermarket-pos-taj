/**
 * JsonDiffViewer — Side-by-side JSON diff viewer.
 *
 * Renders DiffNode[] from json-diff.ts as a collapsible tree.
 * Colors: added = pos-accent/10 bg + text-pos-accent
 *         removed = destructive/10 bg + text-destructive
 *         unchanged = transparent bg + text-muted-foreground
 *
 * UI-SPEC Phase 14: Diff viewer section.
 */
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { diffJson } from '@shared/lib/json-diff';
import type { DiffNode } from '@shared/lib/json-diff';
import { cn } from '@shared/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JsonDiffViewerProps {
  before: unknown;
  after: unknown;
  /** Show "Payload truncated at 64 KB" notice */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// DiffLine
// ---------------------------------------------------------------------------

interface DiffLineProps {
  node: DiffNode;
  depth: number;
}

function DiffLine({ node, depth }: DiffLineProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = (node.children?.length ?? 0) > 0;

  const bgClass = cn(
    node.status === 'added'
      ? 'bg-success-soft'
      : node.status === 'removed'
        ? 'bg-destructive/10'
        : 'bg-transparent'
  );

  const textClass = cn(
    node.status === 'added'
      ? 'text-success-strong'
      : node.status === 'removed'
        ? 'text-destructive'
        : 'text-muted-foreground'
  );

  const gutter = node.status === 'added' ? '+' : node.status === 'removed' ? '−' : ' ';

  const gutterClass = cn(
    node.status === 'added'
      ? 'text-success-strong'
      : node.status === 'removed'
        ? 'text-destructive'
        : 'text-muted-foreground'
  );

  return (
    <>
      <div
        className={cn(
          'flex items-start gap-1 py-1 px-2 font-mono text-xs leading-6 rounded-sm',
          bgClass
        )}
        style={{ paddingLeft: `${String(8 + depth * 16)}px` }}
      >
        {/* Gutter marker */}
        <span className={cn('w-3 shrink-0 select-none', gutterClass)}>{gutter}</span>

        {/* Expand toggle for objects */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => {
              setExpanded(e => !e);
            }}
            aria-expanded={expanded}
            aria-label={`${expanded ? t('jsonDiffViewer.collapse') : t('jsonDiffViewer.expand')} ${node.key}`}
            className="mr-1 size-4 shrink-0 flex items-center justify-center"
          >
            <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* Key */}
        <span className={cn('mr-1 font-semibold', textClass)}>{node.key}:</span>

        {/* Value (leaf nodes) */}
        {!hasChildren && (
          <span className={textClass}>
            {node.status === 'removed' ? JSON.stringify(node.before) : JSON.stringify(node.after)}
          </span>
        )}
      </div>

      {/* Children */}
      {hasChildren &&
        expanded &&
        node.children?.map((child, i) => (
          <DiffLine key={`${child.key}-${String(i)}`} node={child} depth={depth + 1} />
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// JsonDiffViewer
// ---------------------------------------------------------------------------

export function JsonDiffViewer({ before, after, truncated }: JsonDiffViewerProps) {
  const { t } = useTranslation('common');
  const nodes = diffJson(before, after);
  const [expandAll, setExpandAll] = useState(false);

  const bothEmpty = before == null && after == null;

  if (bothEmpty) {
    return (
      <p className="text-muted-foreground text-sm py-4 text-center">
        {t('jsonDiffViewer.noPayload')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {truncated && (
        <div className="rounded border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          {t('jsonDiffViewer.truncated')}
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="font-semibold uppercase tracking-wide">
            {t('jsonDiffViewer.before')}
          </span>
          <span className="font-semibold uppercase tracking-wide">{t('jsonDiffViewer.after')}</span>
        </div>
        <button
          type="button"
          onClick={() => {
            setExpandAll(e => !e);
          }}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {expandAll ? t('jsonDiffViewer.collapseAll') : t('jsonDiffViewer.expandAll')}
        </button>
      </div>

      {/* Diff tree */}
      <div className="rounded border border-border overflow-auto">
        {nodes.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">
            {t('jsonDiffViewer.noChanges')}
          </p>
        ) : (
          nodes.map((node, i) => (
            <DiffLine key={`${node.key}-${String(i)}`} node={node} depth={0} />
          ))
        )}
      </div>
    </div>
  );
}
