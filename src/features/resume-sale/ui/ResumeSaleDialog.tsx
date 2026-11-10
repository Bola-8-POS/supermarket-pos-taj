import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CartItem, CheckoutDraft } from '@shared/lib/domain';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@shared/ui/alert-dialog';
import { Button } from '@shared/ui/button';
import { RestoredValueReview } from './RestoredValueReview';

export interface ResumeSaleDialogProps {
  open: boolean;
  items: ReadonlyArray<CartItem>;
  totalCents: number;
  draft: CheckoutDraft | null;
  onResume: () => void;
  onDiscard: () => void;
}

/**
 * D-01: blocking Resume / Discard choice. Escape and outside press do nothing, there is no close
 * control, and Resume Sale has initial focus. Each button fires once.
 */
export function ResumeSaleDialog({ open, items, totalCents, draft, onResume, onDiscard }: ResumeSaleDialogProps) {
  const { t } = useTranslation('wPanels');
  const resumeRef = useRef<HTMLButtonElement>(null);
  const [decided, setDecided] = useState(false);

  const decide = (action: () => void) => {
    if (decided) return;
    setDecided(true);
    action();
  };

  return (
    <AlertDialog open={open}>
      <AlertDialogContent
        className="max-h-[90vh] max-w-3xl overflow-y-auto"
        // No autoFocus attribute (jsx-a11y/no-autofocus): focus the primary action here.
        onOpenAutoFocus={event => {
          event.preventDefault();
          resumeRef.current?.focus();
        }}
        onEscapeKeyDown={event => {
          event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('resumeSale.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('resumeSale.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <RestoredValueReview items={items} totalCents={totalCents} draft={draft} />
        <AlertDialogFooter>
          <Button
            ref={resumeRef}
            variant="default"
            disabled={decided}
            onClick={() => {
              decide(onResume);
            }}
          >
            {t('resumeSale.resume')}
          </Button>
          <Button
            variant="outline"
            className="text-destructive"
            disabled={decided}
            onClick={() => {
              decide(onDiscard);
            }}
          >
            {t('resumeSale.discard')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
