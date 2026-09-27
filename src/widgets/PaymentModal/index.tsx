import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { PaymentForm } from './ui/PaymentForm';
import type { PaymentFormProps, PaymentProcessors } from './ui/PaymentForm';

export type { PaymentProcessors };
export { PaymentForm };

export interface PaymentModalProps {
  open: boolean;
  tab: PaymentFormProps['tab'];
  /** Current staff profile id (auth user id) — required to process payment */
  staffId: string;
  onClose: () => void;
  onPaymentSuccess?: () => void;
  /** Storybook / tests */
  processors?: PaymentProcessors;
}

export function PaymentModal({
  open,
  tab,
  staffId,
  onClose,
  onPaymentSuccess,
  processors,
}: PaymentModalProps) {
  const { t } = useTranslation('wPanels');
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="top-0 left-0 h-dvh w-screen max-w-none rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[90vh] sm:w-full sm:max-w-3xl sm:rounded-xl sm:p-0 translate-0 sm:-translate-1/2">
        <DialogHeader className="border-b px-4 py-3 sm:px-6 sm:py-4">
          <DialogTitle>{t('paymentModal.processPayment')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('paymentModal.reviewChooseConfirm')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex h-[calc(100dvh-64px)] flex-col sm:h-auto sm:max-h-[calc(90vh-64px)]">
          <PaymentForm
            tab={tab}
            staffId={staffId}
            onPaymentSuccess={() => {
              onPaymentSuccess?.();
            }}
            onClose={onClose}
            {...(processors != null ? { processors } : {})}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
