import { useTranslation } from 'react-i18next';
import { present } from '@shared/lib/local-assistant/presenter';
import { Button } from '@shared/ui/button';
import type { PanelMessage } from '../model/panelStore';
import { ChoiceCard } from './ChoiceCard';
import { PreviewCard, type RenderPinDialog } from './PreviewCard';

/** Every assistant line goes through present() + t(); no model text reaches the DOM. */
export function MessageBubble({
  message,
  onChoose,
  write,
}: {
  message: PanelMessage;
  /** Called with a supplier id when the staff taps one option of a typed choice. */
  onChoose?: (supplierId: string) => void;
  /** What a staged-write preview needs; absent in read-only callers (a preview then has no actions). */
  write?: {
    busy: boolean;
    renderPinDialog: RenderPinDialog;
    onApprove: (messageId: number, approverId: string, approvalId: string) => void;
    onCancel: (messageId: number, reason: 'user' | 'expired') => void;
    onChooseProduct: (messageId: number, itemIndex: number, productId: string) => void;
  };
}) {
  const { t } = useTranslation('featMgmt');

  if (message.role === 'user') {
    return (
      <div className="flex justify-end px-3 py-1">
        <div className="max-w-[75%] break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-xs">
          {message.text}
        </div>
      </div>
    );
  }

  if (message.reply.type === 'choose-products' && write) {
    const { id } = message;
    return (
      <ChoiceCard
        pending={message.reply.pending}
        busy={write.busy}
        onChoose={(itemIndex, productId) => {
          write.onChooseProduct(id, itemIndex, productId);
        }}
      />
    );
  }

  if (message.reply.type === 'preview' && write) {
    const { id } = message;
    return (
      <PreviewCard
        reply={message.reply}
        busy={write.busy}
        renderPinDialog={write.renderPinDialog}
        onApprove={(approverId, approvalId) => {
          write.onApprove(id, approverId, approvalId);
        }}
        onCancel={reason => {
          write.onCancel(id, reason);
        }}
      />
    );
  }

  const presented = present(message.reply);
  return (
    <div className="flex justify-start px-3 py-1">
      <div
        data-testid="assistant-reply"
        className="max-w-[85%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-2.5 text-sm leading-relaxed text-card-foreground shadow-xs"
      >
        <p>{t(presented.key, presented.params)}</p>
        {presented.lines.length > 0 && (
          <ul className="mt-1 space-y-1">
            {presented.lines.map((line, i) => (
              <li key={i} data-testid="assistant-line">
                {t(line.key, line.params)}
              </li>
            ))}
          </ul>
        )}
        {message.reply.type === 'choose' && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.reply.options.map(option => (
              <Button
                key={option.id}
                type="button"
                variant="outline"
                size="sm"
                data-testid="assistant-choice"
                onClick={() => {
                  onChoose?.(option.id);
                }}
              >
                {option.name}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
