import { AlertTriangle, Check, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { present, type PreviewReply } from '@shared/lib/local-assistant/presenter';
import type { StaffAction } from '@shared/lib/rbac';
import { Button } from '@shared/ui/button';
import { TOOL_REGISTRY } from '../model/tool-registry';

/**
 * Props the injected PIN dialog receives. Shaped like ManagerPinDialogProps (the app router passes that dialog in):
 * a feature cannot import its sibling feature, so the dialog arrives as a render prop.
 */
export type PinDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requiredAction: StaffAction;
  description?: string;
  onSuccess: (staff: { id: string }, approvalId: string) => void;
};
export type RenderPinDialog = (props: PinDialogProps) => ReactNode;

type Props = {
  reply: PreviewReply;
  /** True while an approve/cancel call is in flight. */
  busy: boolean;
  renderPinDialog: RenderPinDialog;
  onApprove: (approverId: string, approvalId: string) => void;
  onCancel: (reason: 'user' | 'expired') => void;
  /** Test hook. */
  now?: () => number;
};

const secondsLeft = (deadline: number, now: number) => Math.max(0, Math.ceil((deadline - now) / 1000));

/**
 * Every item of a server-built preview with its value before and after, a countdown of the server's window and
 * Confirm / Cancel. Confirm opens the manager PIN dialog; nothing is executed from this card (the server runs the
 * staged batch only after the PIN ticket is consumed by assistant_approve).
 */
export function PreviewCard({ reply, busy, renderPinDialog, onApprove, onCancel, now = Date.now }: Props) {
  const { t } = useTranslation('featMgmt');
  const [pinOpen, setPinOpen] = useState(false);
  // The deadline is the till's own time at arrival plus the server's TTL: skew between the two clocks cannot matter.
  const [deadline] = useState(() => now() + reply.expiresInSeconds * 1000);
  const [left, setLeft] = useState(() => secondsLeft(deadline, now()));
  const expiredRef = useRef(false);
  const presented = present(reply);
  const entry = TOOL_REGISTRY[reply.kind];

  useEffect(() => {
    const id = setInterval(() => {
      setLeft(secondsLeft(deadline, now()));
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [deadline, now]);

  // At 0 the window is over (the PIN dialog closes through `over` below): report the expiry exactly once. Never while
  // an approval is in flight (busy): it may be committing, and the approve result replaces this card (WR-01).
  useEffect(() => {
    if (left > 0 || busy || expiredRef.current) return;
    expiredRef.current = true;
    onCancel('expired');
  }, [left, busy, onCancel]);

  const over = left === 0;

  return (
    <div data-testid="assistant-preview" className="mx-3 my-1 rounded-xl border border-warning/40 bg-warning-soft p-3">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-warning-strong" aria-hidden="true" />
        <span className="text-sm font-semibold text-warning-strong">{t(presented.key, presented.params)}</span>
      </div>

      <ul className="mb-2 max-h-64 divide-y divide-border/40 overflow-y-auto rounded-lg bg-background/60 px-3 py-1 text-sm">
        {presented.lines.map((line, i) => (
          <li key={i} data-testid="assistant-preview-row" className="py-1 font-medium text-foreground">
            {t(line.key, line.params)}
          </li>
        ))}
      </ul>

      {reply.kind === 'product.price' && (
        <p data-testid="assistant-one-by-one" className="mb-2 text-xs text-muted-foreground">
          {t('assistant.price.oneByOne')}
        </p>
      )}

      <p data-testid="assistant-countdown" className="mb-2 text-xs text-muted-foreground" aria-live="off">
        {t('assistant.adjust.secondsLeft', { seconds: left })}
      </p>

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          className="flex-1 gap-1"
          disabled={busy || over}
          data-testid="assistant-confirm"
          onClick={() => {
            setPinOpen(true);
          }}
        >
          <Check className="size-3.5" aria-hidden="true" />
          {t('assistant.adjust.confirm')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1"
          disabled={busy || over}
          data-testid="assistant-cancel"
          onClick={() => {
            onCancel('user');
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
          {t('assistant.adjust.cancel')}
        </Button>
      </div>

      {renderPinDialog({
        open: pinOpen && !over,
        onOpenChange: setPinOpen,
        requiredAction: entry.action,
        description: t(
          reply.kind === 'product.price' ? 'assistant.price.pinDescription' : 'assistant.adjust.pinDescription',
          { count: reply.items.length }
        ),
        onSuccess: (staff, approvalId) => {
          setPinOpen(false);
          onApprove(staff.id, approvalId);
        },
      })}
    </div>
  );
}
