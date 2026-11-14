import { Loader2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@shared/ui/alert-dialog';
import { Button } from '@shared/ui/button';

// Selectors as constants: not UI copy (i18next/no-literal-string).
const TABLIST_SELECTOR = '[role="tablist"]';
const SELECTED_TAB_SELECTOR = '[role="tab"][aria-selected="true"]';

export interface UnsavedChangesDialogProps {
  open: boolean;
  saving: boolean;
  saveError: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}

/**
 * Save and Continue / Discard Changes / Stay Here prompt shown when leaving a
 * Settings tab (or the page entirely) while it has unsaved changes. Driven by
 * `useUnsavedChangesController`'s `dialogProps`. Escape, outside click and the
 * close control all mean Stay Here; the safest action has initial focus.
 */
export function UnsavedChangesDialog({
  open,
  saving,
  saveError,
  onSave,
  onDiscard,
  onStay,
}: UnsavedChangesDialogProps) {
  const { t } = useTranslation('settings');
  const stayRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Radix AlertDialog swallows outside pointer-downs by design; treat a press
  // outside the dialog panel (the overlay) as Stay Here (D-15).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && contentRef.current && !contentRef.current.contains(target)) {
        onStay();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, onStay]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={isOpen => {
        // onStay itself ignores the call while a save is in flight.
        if (!isOpen) onStay();
      }}
    >
      <AlertDialogContent
        ref={contentRef}
        // No `autoFocus` attribute (jsx-a11y/no-autofocus): move initial focus
        // to the safe action here, and restore the opener's focus on close.
        onOpenAutoFocus={event => {
          event.preventDefault();
          openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          stayRef.current?.focus();
        }}
        onCloseAutoFocus={event => {
          // Radix AlertDialog has no trigger here; return focus to the element
          // that was focused before the dialog opened.
          event.preventDefault();
          let target = openerRef.current;
          // Focusing a non-selected tab trigger would activate it (automatic
          // activation) and re-open this guard: land on the selected tab instead.
          if (target?.getAttribute('role') === 'tab' && target.getAttribute('aria-selected') !== 'true') {
            target = target.closest(TABLIST_SELECTOR)?.querySelector<HTMLElement>(SELECTED_TAB_SELECTOR) ?? null;
          }
          target?.focus();
          openerRef.current = null;
        }}
      >
        <Button
          type="button"
          variant="ghost"
          aria-label={t('unsavedChanges.close')}
          disabled={saving}
          className="absolute right-2 top-2 p-0 size-11"
          onClick={onStay}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('unsavedChanges.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('unsavedChanges.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        {saveError && (
          <p role="alert" className="text-sm text-destructive">
            {t('unsavedChanges.saveFailed')}
          </p>
        )}
        <AlertDialogFooter>
          <Button disabled={saving} onClick={onSave}>
            {saving && <Loader2 className="mr-2 animate-spin size-4" aria-hidden="true" />}
            {saving
              ? t('unsavedChanges.saving')
              : saveError
                ? t('unsavedChanges.retrySave')
                : t('unsavedChanges.save')}
          </Button>
          <Button variant="outline" className="text-destructive" disabled={saving} onClick={onDiscard}>
            {t('unsavedChanges.discard')}
          </Button>
          <Button ref={stayRef} variant="outline" disabled={saving} onClick={onStay}>
            {t('unsavedChanges.stay')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
