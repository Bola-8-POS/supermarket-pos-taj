/**
 * CONFIRM DIALOG COMPONENT
 *
 * Confirmation dialog with destructive variant support.
 * Wraps shadcn AlertDialog with consistent styling.
 */

import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { useLockStateStore } from '@shared/lib/lock-state-store';
import { cn } from '@shared/lib/utils';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';

export interface ConfirmDialogProps {
  /** Whether dialog is open */
  open: boolean;
  /** Dialog title */
  title: string;
  /** Dialog description */
  description: string;
  /** Confirm button label (default: "Confirm") */
  confirmLabel?: string;
  /** Cancel button label (default: "Cancel") */
  cancelLabel?: string;
  /** Button variant - destructive shows red confirm button */
  variant?: 'default' | 'destructive';
  /** Called when user confirms */
  onConfirm: () => void | Promise<void>;
  /** Called when user cancels */
  onCancel: () => void;
  /** Loading state - shows spinner, disables buttons */
  isLoading?: boolean;
  /** Optional custom body content rendered under description */
  children?: React.ReactNode;
  /** Disable confirm action until requirements are met */
  confirmDisabled?: boolean;
  /** Optional extra classes merged onto the confirm button (opt-in only; no default changes) */
  confirmClassName?: string;
}

/**
 * ConfirmDialog - Confirmation dialog with keyboard support
 *
 * Features:
 * - Destructive variant for dangerous actions (red confirm button)
 * - Loading state with spinner in confirm button
 * - Keyboard support: Enter = confirm, Escape = cancel
 * - Accessible with proper ARIA labels
 *
 * @example
 * ```tsx
 * <ConfirmDialog
 *   open={isOpen}
 *   title="Close Tab?"
 *   description="This will finalize the tab and require payment."
 *   confirmLabel="Close Tab"
 *   variant="destructive"
 *   onConfirm={handleCloseTab}
 *   onCancel={() => setIsOpen(false)}
 *   isLoading={isClosing}
 * />
 * ```
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
  isLoading = false,
  children,
  confirmDisabled = false,
  confirmClassName,
}: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  const locked = useLockStateStore(s => s.locked);
  // Radix's AlertDialogAction/AlertDialogCancel are both internally a
  // DialogPrimitive.Close — clicking EITHER one closes the dialog and fires
  // onOpenChange(false), which would otherwise also invoke onCancel below
  // (double-firing onCancel on a Cancel click, and incorrectly firing
  // onCancel after a Confirm click). This ref tracks "already handled by an
  // explicit button click" so onOpenChange only calls onCancel for a true
  // dismiss (Escape / outside click / no button pressed).
  const handledRef = React.useRef(false);

  const handleConfirm = React.useCallback(async () => {
    handledRef.current = true;
    await onConfirm();
  }, [onConfirm]);

  const handleCancel = React.useCallback(() => {
    handledRef.current = true;
    onCancel();
  }, [onCancel]);

  // Keyboard support. Gated on `locked` (idle-screen-lock, D-01: "no
  // exemption, even mid-transaction") -- this listener is attached to
  // `window`, not scoped to any DOM node inside the dialog, so it fires on
  // any Enter/Escape keypress regardless of focus. Without this guard, a
  // ConfirmDialog left open when the terminal locks (e.g. PaymentForm's
  // offline-retry dialog) can have its onConfirm mutation fired blind by a
  // stray keypress while the visual lock overlay is on top of it.
  React.useEffect(() => {
    if (!open || isLoading || locked) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void handleConfirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, isLoading, locked, handleConfirm, handleCancel]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={isOpen => {
        if (!isOpen) {
          if (!handledRef.current) {
            onCancel();
          }
          handledRef.current = false;
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading} onClick={handleCancel}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={isLoading || confirmDisabled}
            onClick={() => {
              void handleConfirm();
            }}
            className={cn(
              variant === 'destructive' &&
                'bg-destructive text-destructive-foreground hover:bg-destructive/90',
              confirmClassName
            )}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('loading.generic')}
              </>
            ) : (
              confirmLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
