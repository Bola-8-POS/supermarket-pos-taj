/**
 * CategoryTreeEditor
 *
 * Feature component: admin creates/edits/manages a 3-deep category tree.
 *
 * Rules enforced in UI:
 *   - Maximum 3 levels (root → child → grandchild; depth 0-2)
 *   - Cannot create a 4th level — "Add child" is hidden at depth 2
 *
 * Data flow:
 *   - Reads from `@entities/category` (useCategories, useCategoryTree)
 *   - Writes via useMutationCreateCategory, useMutationUpdateCategory
 */

import { Beer, ChevronDown, ChevronRight, Pencil, Plus, UtensilsCrossed } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  useCategories,
  useMutationCreateCategory,
  useMutationUpdateCategory,
} from '@entities/category';
import type { Category } from '@entities/category';
import { MAX_DEPTH, wouldViolateDepth } from '@shared/lib/category-tree';
import type { CategoryCreate, CategoryRouting, CategoryUpdate } from '@shared/lib/domain';
import { FormField } from '@shared/ui/FormField';
import { POSButton } from '@shared/ui/POSButton';
import { RoutingBadge } from '@shared/ui/RoutingBadge';
import { Button } from '@shared/ui/button';
import { Checkbox } from '@shared/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';

// ============================================================================
// CATEGORY FORM
// ============================================================================

interface CategoryFormData {
  name: string;
  color: string;
  routing: CategoryRouting;
  comboEligible: boolean;
}

interface CategoryFormProps {
  initial: CategoryFormData;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (data: CategoryFormData) => void;
}

function CategoryForm({ initial, submitting, onCancel, onSubmit }: CategoryFormProps) {
  const { t } = useTranslation('featMgmt');
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [routing, setRouting] = useState<CategoryRouting>(initial.routing);
  const [comboEligible, setComboEligible] = useState(initial.comboEligible);

  function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit({ name: trimmed, color, routing, comboEligible });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <FormField label={t('manageCategories.form.nameLabel')}>
        <Input
          id="cat-name"
          value={name}
          onChange={e => {
            setName(e.target.value);
          }}
          placeholder={t('manageCategories.form.namePlaceholder')}
          maxLength={50}
          required
        />
      </FormField>
      <FormField label={t('manageCategories.form.colorLabel')}>
        <div className="flex items-center gap-3">
          {/* native color input — no shared/ui color-picker primitive exists, see 31-CONTEXT.md D-05 */}
          <input
            id="cat-color"
            type="color"
            value={color}
            onChange={e => {
              setColor(e.target.value);
            }}
            className="h-9 w-16 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
          <span className="text-sm text-muted-foreground">{color}</span>
        </div>
      </FormField>
      <FormField label={t('manageCategories.form.routingLabel')}>
        <Select
          value={routing}
          onValueChange={value => {
            setRouting(value as CategoryRouting);
          }}
        >
          <SelectTrigger id="cat-routing">
            <SelectValue placeholder={t('manageCategories.form.routingPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="KITCHEN">
              <UtensilsCrossed className="size-3.5" aria-hidden />{' '}
              {t('manageCategories.form.kitchenOption')}
            </SelectItem>
            <SelectItem value="BAR">
              <Beer className="size-3.5" aria-hidden /> {t('manageCategories.form.barOption')}
            </SelectItem>
            <SelectItem value="NONE">{t('manageCategories.form.noneOption')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('manageCategories.form.routingHelp')}
        </p>
      </FormField>
      <div className="flex items-center gap-2">
        <Checkbox
          id="category-combo-eligible"
          checked={comboEligible}
          onCheckedChange={v => {
            setComboEligible(v === true);
          }}
        />
        <label htmlFor="category-combo-eligible" className="text-sm font-medium">
          {t('manageCategories.form.comboEligibleLabel')}
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <POSButton type="button" variant="outline" touchSize="default" onClick={onCancel}>
          {t('common:actions.cancel')}
        </POSButton>
        <POSButton type="submit" touchSize="default" disabled={submitting || !name.trim()}>
          {submitting ? t('common:actions.saving') : t('common:actions.save')}
        </POSButton>
      </div>
    </form>
  );
}

// ============================================================================
// TREE NODE ROW
// ============================================================================

interface CategoryWithDepth {
  category: Category;
  depth: number;
  children: CategoryWithDepth[];
}

interface NodeRowProps {
  item: CategoryWithDepth;
  allCategories: Category[];
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onEdit: (cat: Category) => void;
  onAddChild: (parentId: string) => void;
}

function NodeRow({ item, allCategories, expandedIds, onToggle, onEdit, onAddChild }: NodeRowProps) {
  const { t } = useTranslation('featMgmt');
  const { category, depth, children } = item;
  const isExpanded = expandedIds.has(category.id);
  const hasChildren = children.length > 0;
  const canAddChild = depth < MAX_DEPTH;
  const indentPx = depth * 24;

  return (
    <li>
      <div
        className="flex items-center gap-2 py-1.5"
        style={{ paddingLeft: `${String(indentPx + 8)}px` }}
      >
        {/* Expand toggle */}
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={
            isExpanded
              ? t('manageCategories.tree.collapseAria', { name: category.name })
              : t('manageCategories.tree.expandAria', { name: category.name })
          }
          className={[
            'flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground',
            'hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none',
            !hasChildren ? 'invisible pointer-events-none' : '',
          ].join(' ')}
          onClick={() => {
            if (hasChildren) onToggle(category.id);
          }}
          tabIndex={-1}
        >
          {hasChildren &&
            (isExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            ))}
        </Button>

        {/* Color swatch */}
        <span
          className="size-3.5 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: category.color }}
          aria-hidden
        />

        {/* Name */}
        <span className="flex-1 text-sm font-medium">{category.name}</span>

        {/* Routing */}
        {category.routing === 'NONE' ? (
          <span className="text-xs text-muted-foreground">
            {t('manageCategories.tree.notRouted')}
          </span>
        ) : (
          <RoutingBadge routing={category.routing} />
        )}

        {/* Combo eligibility */}
        {!category.comboEligible ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {t('manageCategories.tree.noCombosTag')}
          </span>
        ) : null}

        {/* Depth badge */}
        <span className="text-xs text-muted-foreground">
          {t('manageCategories.tree.depthBadge', { level: depth + 1 })}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <POSButton
            type="button"
            variant="ghost"
            touchSize="default"
            aria-label={t('manageCategories.tree.editAria', { name: category.name })}
            onClick={() => {
              onEdit(category);
            }}
          >
            <Pencil className="size-3.5" />
          </POSButton>
          {canAddChild && (
            <POSButton
              type="button"
              variant="ghost"
              touchSize="default"
              aria-label={t('manageCategories.tree.addSubcategoryAria', { name: category.name })}
              onClick={() => {
                onAddChild(category.id);
              }}
            >
              <Plus className="size-3.5" />
            </POSButton>
          )}
        </div>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <ul>
          {children.map(child => (
            <NodeRow
              key={child.category.id}
              item={child}
              allCategories={allCategories}
              expandedIds={expandedIds}
              onToggle={onToggle}
              onEdit={onEdit}
              onAddChild={onAddChild}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ============================================================================
// TREE BUILDER
// ============================================================================

function buildTree(categories: Category[]): CategoryWithDepth[] {
  const byId = new Map<string, CategoryWithDepth>();
  for (const c of categories) {
    byId.set(c.id, { category: c, depth: 0, children: [] });
  }

  const roots: CategoryWithDepth[] = [];
  for (const item of byId.values()) {
    const pid = item.category.parentId ?? null;
    if (pid == null) {
      roots.push(item);
    } else {
      const parent = byId.get(pid);
      if (parent != null) {
        parent.children.push(item);
      } else {
        roots.push(item); // orphan → root
      }
    }
  }

  function assignDepths(nodes: CategoryWithDepth[], depth: number): void {
    for (const n of nodes) {
      n.depth = depth;
      n.children.sort(
        (a, b) =>
          a.category.sortOrder - b.category.sortOrder ||
          a.category.name.localeCompare(b.category.name)
      );
      assignDepths(n.children, depth + 1);
    }
  }

  roots.sort(
    (a, b) =>
      a.category.sortOrder - b.category.sortOrder || a.category.name.localeCompare(b.category.name)
  );
  assignDepths(roots, 0);
  return roots;
}

// ============================================================================
// MAIN EDITOR COMPONENT
// ============================================================================

export function CategoryTreeEditor() {
  const { t } = useTranslation('featMgmt');
  const { data: categories, isLoading, resultError } = useCategories();
  const createMutation = useMutationCreateCategory();
  const updateMutation = useMutationUpdateCategory();

  // Expand/collapse state
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Dialog state
  type DialogMode =
    | { kind: 'create-root' }
    | { kind: 'create-child'; parentId: string }
    | { kind: 'edit'; category: Category };
  const [dialog, setDialog] = useState<DialogMode | null>(null);

  async function handleCreate(data: CategoryFormData, parentId: string | null) {
    const allCats = categories ?? [];

    // Guard: would violate depth?
    if (
      wouldViolateDepth(
        null,
        parentId,
        allCats.map(c => ({ id: c.id, parentId: c.parentId }))
      )
    ) {
      toast.error(t('manageCategories.maxDepthError'));
      return;
    }

    const createPayload: CategoryCreate = {
      name: data.name,
      color: data.color,
      sortOrder: allCats.filter(c => (c.parentId ?? null) === parentId).length,
      happyHourStart: null,
      happyHourEnd: null,
      routing: data.routing,
      parentId: parentId ?? undefined,
      comboEligible: data.comboEligible,
    };

    const r = await createMutation.mutateAsync(createPayload);
    if (!r.ok) {
      toast.error(r.error.message);
    } else {
      toast.success(t('manageCategories.categoryCreated'));
      setDialog(null);
    }
  }

  async function handleUpdate(id: string, data: CategoryFormData) {
    const payload: CategoryUpdate = {
      id,
      name: data.name,
      color: data.color,
      routing: data.routing,
      comboEligible: data.comboEligible,
    };
    const r = await updateMutation.mutateAsync(payload);
    if (!r.ok) {
      toast.error(r.error.message);
    } else {
      toast.success(t('manageCategories.categorySaved'));
      setDialog(null);
    }
  }

  if (resultError) {
    return (
      <p className="text-destructive text-sm">
        {t('manageCategories.loadError', { message: resultError.message })}
      </p>
    );
  }

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">{t('manageCategories.loading')}</p>;
  }

  const tree = buildTree(categories ?? []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('manageCategories.headerHelp')}</p>
        <POSButton
          type="button"
          touchSize="default"
          onClick={() => {
            setDialog({ kind: 'create-root' });
          }}
        >
          <Plus className="size-4" />
          {t('manageCategories.addRootCategory')}
        </POSButton>
      </div>

      {/* Tree */}
      {tree.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
          {t('manageCategories.emptyState')}
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          {tree.map(item => (
            <NodeRow
              key={item.category.id}
              item={item}
              allCategories={categories ?? []}
              expandedIds={expandedIds}
              onToggle={toggleExpand}
              onEdit={cat => {
                setDialog({ kind: 'edit', category: cat });
              }}
              onAddChild={parentId => {
                setDialog({ kind: 'create-child', parentId });
              }}
            />
          ))}
        </ul>
      )}

      {/* Create/Edit Dialog */}
      <Dialog
        open={dialog != null}
        onOpenChange={o => {
          if (!o) setDialog(null);
        }}
      >
        <DialogContent className="max-w-md sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === 'edit'
                ? t('manageCategories.editDialogTitle', { name: dialog.category.name })
                : dialog?.kind === 'create-child'
                  ? t('manageCategories.newSubcategoryTitle')
                  : t('manageCategories.newRootCategoryTitle')}
            </DialogTitle>
          </DialogHeader>
          {dialog != null && (
            <CategoryForm
              key={dialog.kind === 'edit' ? dialog.category.id : dialog.kind}
              initial={
                dialog.kind === 'edit'
                  ? {
                      name: dialog.category.name,
                      color: dialog.category.color,
                      routing: dialog.category.routing,
                      comboEligible: dialog.category.comboEligible,
                    }
                  : // TOKEN-01 exempt: category.color is arbitrary per-row USER DATA (each category
                    // picks its own color), not an app theme color. Do not map to a Tailwind CSS-variable
                    // token — see 31-CONTEXT.md D-08.
                    // eslint-disable-next-line no-restricted-syntax, i18next/no-literal-string -- 31-CONTEXT.md D-08: category.color is per-row user data, not a theme color / translatable copy
                    { name: '', color: '#6366f1', routing: 'NONE', comboEligible: true }
              }
              submitting={createMutation.isPending || updateMutation.isPending}
              onCancel={() => {
                setDialog(null);
              }}
              onSubmit={data => {
                if (dialog.kind === 'edit') {
                  void handleUpdate(dialog.category.id, data);
                } else if (dialog.kind === 'create-child') {
                  void handleCreate(data, dialog.parentId);
                } else {
                  void handleCreate(data, null);
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
