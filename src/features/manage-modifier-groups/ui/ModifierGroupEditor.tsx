/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * ModifierGroupEditor
 *
 * Feature component: admin manages modifier groups (CRUD) and attaches
 * modifiers to groups. Admin-only — placed in an admin-gated settings tab.
 *
 * Uses `const db = supabase as any` pre-regen cast because modifier_groups
 * and modifier_group_items are new tables not yet fully typed in supabase.types.ts.
 * Regenerate types with: npx supabase gen types typescript --local > src/shared/lib/supabase.types.ts
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useModifiers } from '@entities/product';
import type { Modifier, ModifierGroup, ModifierGroupCreate } from '@shared/lib/domain';
import { ModifierGroupSchema } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, unknownError } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { ConfirmDialog } from '@shared/ui/ConfirmDialog';
import { FormField } from '@shared/ui/FormField';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { POSButton } from '@shared/ui/POSButton';
import { Checkbox } from '@shared/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';

// Pre-regen cast — remove once supabase.types.ts is regenerated after Plan 02 migrations
const db = supabase as any;

// ============================================================================
// QUERY KEYS
// ============================================================================

const MODIFIER_GROUPS_KEY = ['modifier_groups'] as const;
const MODIFIER_GROUP_ITEMS_KEY = ['modifier_group_items'] as const;

// ============================================================================
// HOOKS
// ============================================================================

function useModifierGroups() {
  return useQuery({
    queryKey: MODIFIER_GROUPS_KEY,
    queryFn: async () => {
      /* eslint-disable i18next/no-literal-string -- Supabase query-builder table/column identifiers, not UI copy */
      const { data, error } = await db
        .from('modifier_groups')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      /* eslint-enable i18next/no-literal-string */
      if (error) {
        logger.error('useModifierGroups: query failed', { error });
        throw error;
      }
      return ((data ?? []) as unknown[]).map((row: unknown) => {
        const r = row as Record<string, unknown>;
        return ModifierGroupSchema.parse({
          id: r['id'],
          name: r['name'],
          minSelect: r['min_select'],
          maxSelect: r['max_select'],
          isRequired: r['is_required'],
          sortOrder: r['sort_order'],
          createdAt: new Date(r['created_at'] as string),
        });
      });
    },
  });
}

function useModifierGroupItems(groupId: string | null) {
  return useQuery({
    queryKey: [...MODIFIER_GROUP_ITEMS_KEY, groupId],
    enabled: groupId != null,
    queryFn: async () => {
      if (groupId == null) return [] as string[];
      /* eslint-disable i18next/no-literal-string -- Supabase query-builder table/column identifiers, not UI copy */
      const { data, error } = await db
        .from('modifier_group_items')
        .select('modifier_id')
        .eq('group_id', groupId)
        .order('sort_order', { ascending: true });
      /* eslint-enable i18next/no-literal-string */
      if (error) throw error;
      return ((data ?? []) as unknown[]).map(
        (r: unknown) => (r as Record<string, unknown>)['modifier_id'] as string
      );
    },
  });
}

function useMutationCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ModifierGroupCreate) => {
      const { error } = await db.from('modifier_groups').insert({
        name: payload.name,
        min_select: payload.minSelect,
        max_select: payload.maxSelect,
        is_required: payload.isRequired,
        sort_order: payload.sortOrder,
      });
      if (error) return err(unknownError(error));
      return ok(undefined);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MODIFIER_GROUPS_KEY });
    },
  });
}

function useMutationUpdateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      id: string;
      name: string;
      minSelect: number;
      maxSelect: number;
      isRequired: boolean;
    }) => {
      /* eslint-disable i18next/no-literal-string -- Supabase query-builder table/column identifiers, not UI copy */
      const { error } = await db
        .from('modifier_groups')
        .update({
          name: payload.name,
          min_select: payload.minSelect,
          max_select: payload.maxSelect,
          is_required: payload.isRequired,
        })
        .eq('id', payload.id);
      /* eslint-enable i18next/no-literal-string */
      if (error) return err(unknownError(error));
      return ok(undefined);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MODIFIER_GROUPS_KEY });
    },
  });
}

function useMutationDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from('modifier_groups').delete().eq('id', id);
      if (error) return err(unknownError(error));
      return ok(undefined);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MODIFIER_GROUPS_KEY });
    },
  });
}

function useMutationSetGroupItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ groupId, modifierIds }: { groupId: string; modifierIds: string[] }) => {
      /* eslint-disable i18next/no-literal-string -- Supabase query-builder table/column identifiers, not UI copy */
      const { error: delErr } = await db
        .from('modifier_group_items')
        .delete()
        .eq('group_id', groupId);
      /* eslint-enable i18next/no-literal-string */
      if (delErr) return err(unknownError(delErr));

      if (modifierIds.length > 0) {
        const rows = modifierIds.map((mid, i) => ({
          group_id: groupId,
          modifier_id: mid,
          sort_order: i,
        }));
        const { error: insErr } = await db.from('modifier_group_items').insert(rows);
        if (insErr) return err(unknownError(insErr));
      }
      return ok(undefined);
    },
    onSuccess: (_result: unknown, vars: { groupId: string; modifierIds: string[] }) => {
      void qc.invalidateQueries({ queryKey: [...MODIFIER_GROUP_ITEMS_KEY, vars.groupId] });
    },
  });
}

// ============================================================================
// GROUP FORM
// ============================================================================

interface GroupFormData {
  name: string;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
}

interface GroupFormProps {
  initial: GroupFormData;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (data: GroupFormData) => void;
}

function GroupForm({ initial, submitting, onCancel, onSubmit }: GroupFormProps) {
  const { t } = useTranslation('featMgmt');
  const [name, setName] = useState(initial.name);
  const [minSelect, setMinSelect] = useState(String(initial.minSelect));
  const [maxSelect, setMaxSelect] = useState(String(initial.maxSelect));
  const [isRequired, setIsRequired] = useState(initial.isRequired);

  function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const min = parseInt(minSelect, 10);
    const max = parseInt(maxSelect, 10);
    if (isNaN(min) || isNaN(max) || min < 0 || max < 1 || min > max) {
      toast.error(t('manageModifierGroups.form.invalidSelectionRange'));
      return;
    }
    onSubmit({ name: trimmed, minSelect: min, maxSelect: max, isRequired });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <FormField label={t('manageModifierGroups.form.groupNameLabel')}>
        <Input
          value={name}
          onChange={e => {
            setName(e.target.value);
          }}
          placeholder={t('manageModifierGroups.form.groupNamePlaceholder')}
          maxLength={100}
          required
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('manageModifierGroups.form.minSelectionsLabel')}>
          <Input
            type="number"
            min={0}
            value={minSelect}
            onChange={e => {
              setMinSelect(e.target.value);
            }}
          />
        </FormField>
        <FormField label={t('manageModifierGroups.form.maxSelectionsLabel')}>
          <Input
            type="number"
            min={1}
            value={maxSelect}
            onChange={e => {
              setMaxSelect(e.target.value);
            }}
          />
        </FormField>
      </div>
      <label htmlFor="group-is-required" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="group-is-required"
          checked={isRequired}
          onCheckedChange={c => {
            setIsRequired(c === true);
          }}
        />
        {t('manageModifierGroups.form.requiredLabel')}
      </label>
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
// MODIFIER SELECTOR
// ============================================================================

interface ModifierSelectorProps {
  group: ModifierGroup;
  onClose: () => void;
}

function ModifierSelector({ group, onClose }: ModifierSelectorProps) {
  const { t } = useTranslation('featMgmt');
  const { data: allModifiers } = useModifiers();
  const { data: attachedIds } = useModifierGroupItems(group.id);
  const setItemsMutation = useMutationSetGroupItems();

  const resolvedIds = attachedIds ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => new Set(resolvedIds));

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleSave() {
    const r = (await setItemsMutation.mutateAsync({
      groupId: group.id,
      modifierIds: Array.from(selected),
    })) as { ok: boolean; error: { message: string } };
    if (!r.ok) {
      toast.error(r.error.message);
    } else {
      toast.success(t('manageModifierGroups.selector.modifiersUpdated'));
      onClose();
    }
  }

  const sorted = [...(allModifiers ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('manageModifierGroups.selector.selectModifiersFor')} <strong>{group.name}</strong>.
      </p>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('manageModifierGroups.selector.noModifiersAvailable')}
        </p>
      ) : (
        <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-xl border border-border bg-card shadow-xs">
          {sorted.map((m: Modifier) => (
            <li key={m.id} className="flex items-center gap-3 px-3 py-2">
              <Checkbox
                id={`mod-${m.id}`}
                checked={selected.has(m.id)}
                onCheckedChange={() => {
                  toggle(m.id);
                }}
              />
              <label htmlFor={`mod-${m.id}`} className="flex flex-1 items-center gap-2 text-sm">
                <span className="flex-1">{m.name}</span>
                <MoneyDisplay amount={m.priceDelta} />
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <POSButton type="button" variant="outline" touchSize="default" onClick={onClose}>
          {t('common:actions.cancel')}
        </POSButton>
        <POSButton
          type="button"
          touchSize="default"
          disabled={setItemsMutation.isPending}
          onClick={() => {
            void handleSave();
          }}
        >
          {setItemsMutation.isPending ? t('common:actions.saving') : t('common:actions.save')}
        </POSButton>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN EDITOR
// ============================================================================

export function ModifierGroupEditor() {
  const { t } = useTranslation('featMgmt');
  const { data: groups, isLoading, error: queryError } = useModifierGroups();
  const createMutation = useMutationCreateGroup();
  const updateMutation = useMutationUpdateGroup();
  const deleteMutation = useMutationDeleteGroup();

  type EditorDialog =
    | { kind: 'create' }
    | { kind: 'edit'; group: ModifierGroup }
    | { kind: 'attach'; group: ModifierGroup }
    | { kind: 'delete'; group: ModifierGroup };

  const [dialog, setDialog] = useState<EditorDialog | null>(null);

  if (queryError) {
    return (
      <p className="text-destructive text-sm">
        {t('manageModifierGroups.editor.loadError', { message: queryError.message })}
      </p>
    );
  }

  if (isLoading) {
    return (
      <p className="text-muted-foreground text-sm">{t('manageModifierGroups.editor.loading')}</p>
    );
  }

  async function handleCreate(data: GroupFormData) {
    const payload: ModifierGroupCreate = {
      name: data.name,
      minSelect: data.minSelect,
      maxSelect: data.maxSelect,
      isRequired: data.isRequired,
      sortOrder: (groups ?? []).length,
    };
    const r = await createMutation.mutateAsync(payload);
    if (!r.ok) {
      toast.error(r.error.message);
    } else {
      toast.success(t('manageModifierGroups.editor.groupCreated'));
      setDialog(null);
    }
  }

  async function handleUpdate(id: string, data: GroupFormData) {
    const r = await updateMutation.mutateAsync({ id, ...data });
    if (!r.ok) {
      toast.error(r.error.message);
    } else {
      toast.success(t('manageModifierGroups.editor.groupSaved'));
      setDialog(null);
    }
  }

  async function handleDelete(id: string) {
    const r = await deleteMutation.mutateAsync(id);
    if (!r.ok) {
      toast.error(r.error.message);
    } else {
      toast.success(t('manageModifierGroups.editor.groupDeleted'));
      setDialog(null);
    }
  }

  const sorted = [...(groups ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t('manageModifierGroups.editor.headerHelp')}
        </p>
        <POSButton
          type="button"
          touchSize="default"
          onClick={() => {
            setDialog({ kind: 'create' });
          }}
        >
          <Plus className="size-4" />
          {t('manageModifierGroups.editor.addGroup')}
        </POSButton>
      </div>

      {sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
          {t('manageModifierGroups.editor.emptyState')}
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          {sorted.map(group => (
            <li key={group.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{group.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t('manageModifierGroups.editor.selectRange', {
                    min: group.minSelect,
                    max: group.maxSelect,
                  })}
                  {group.isRequired
                    ? t('manageCombos.builder.requiredSuffix')
                    : t('manageCombos.builder.optionalSuffix')}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <POSButton
                  type="button"
                  variant="outline"
                  touchSize="default"
                  aria-label={t('manageModifierGroups.editor.attachModifiersAria', {
                    name: group.name,
                  })}
                  onClick={() => {
                    setDialog({ kind: 'attach', group });
                  }}
                >
                  <Tags className="size-3.5" />
                  <span className="ml-1 text-xs">{t('manageModifierGroups.editor.modifiers')}</span>
                </POSButton>
                <POSButton
                  type="button"
                  variant="outline"
                  touchSize="default"
                  aria-label={t('manageModifierGroups.editor.editAria', { name: group.name })}
                  onClick={() => {
                    setDialog({ kind: 'edit', group });
                  }}
                >
                  <Pencil className="size-3.5" />
                </POSButton>
                <POSButton
                  type="button"
                  variant="outline"
                  touchSize="default"
                  aria-label={t('manageModifierGroups.editor.deleteAria', { name: group.name })}
                  onClick={() => {
                    setDialog({ kind: 'delete', group });
                  }}
                >
                  <Trash2 className="size-3.5" />
                </POSButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Create / Edit dialog */}
      <Dialog
        open={dialog?.kind === 'create' || dialog?.kind === 'edit'}
        onOpenChange={o => {
          if (!o) setDialog(null);
        }}
      >
        <DialogContent className="max-w-md sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === 'edit'
                ? t('manageModifierGroups.editor.editGroupTitle', { name: dialog.group.name })
                : t('manageModifierGroups.editor.newGroupTitle')}
            </DialogTitle>
          </DialogHeader>
          {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
            <GroupForm
              key={dialog.kind === 'edit' ? dialog.group.id : 'create'}
              initial={
                dialog.kind === 'edit'
                  ? {
                      name: dialog.group.name,
                      minSelect: dialog.group.minSelect,
                      maxSelect: dialog.group.maxSelect,
                      isRequired: dialog.group.isRequired,
                    }
                  : { name: '', minSelect: 0, maxSelect: 1, isRequired: false }
              }
              submitting={createMutation.isPending || updateMutation.isPending}
              onCancel={() => {
                setDialog(null);
              }}
              onSubmit={data => {
                if (dialog.kind === 'edit') {
                  void handleUpdate(dialog.group.id, data);
                } else {
                  void handleCreate(data);
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Attach modifiers dialog */}
      <Dialog
        open={dialog?.kind === 'attach'}
        onOpenChange={o => {
          if (!o) setDialog(null);
        }}
      >
        <DialogContent className="max-w-md sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>{t('manageModifierGroups.editor.attachModifiersTitle')}</DialogTitle>
          </DialogHeader>
          {dialog?.kind === 'attach' && (
            <ModifierSelector
              key={dialog.group.id}
              group={dialog.group}
              onClose={() => {
                setDialog(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          open
          title={t('manageModifierGroups.editor.deleteGroupTitle', { name: dialog.group.name })}
          description={t('manageModifierGroups.editor.deleteGroupDescription')}
          confirmLabel={t('manageModifierGroups.editor.deleteGroupConfirmLabel')}
          onConfirm={() => {
            void handleDelete(dialog.group.id);
          }}
          onCancel={() => {
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
