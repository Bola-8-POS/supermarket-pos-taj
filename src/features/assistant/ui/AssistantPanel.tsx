import { useQueryClient } from '@tanstack/react-query';
import { Send, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  approveProposal,
  assistantGate,
  cancelProposal,
  expiryList,
  lowStock,
  productList,
  productLookup,
  recentSales,
  recordRejection,
  salesSummary,
  stageProposal,
} from '@entities/assistant';
import { usePermissions } from '@entities/staff';
import { useStaffStore } from '@entities/staff/model/store';
import { useFeature } from '@shared/lib/license/features';
import { present, type PendingBatch, type PreviewReply } from '@shared/lib/local-assistant/presenter';
import { screenInput } from '@shared/lib/local-assistant/prompt';
import { err } from '@shared/lib/result';
import { getTerminalId } from '@shared/lib/terminal';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { applyPriceBatch } from '../model/applyPriceBatch';
import { runApproval, runBatchChoice, runCancel, runChoice, runTurn, type GatewayDeps, type WriteDeps } from '../model/gateway';
import { useAssistantHistory } from '../model/historyStore';
import { invalidateAfterWrite } from '../model/invalidateAfterWrite';
import { useAssistantPanelStore } from '../model/panelStore';
import { localModel, modelTag, useAssistantStatus } from '../model/useAssistantStatus';
import { MessageBubble } from './MessageBubble';
import type { RenderPinDialog } from './PreviewCard';
import { TypingIndicator } from './TypingIndicator';

/** The server should always send `until`; if it does not, show a 10-minute lock (the cool-down length) and re-check then. */
const COOL_DOWN_MS = 10 * 60_000;
const lockEnd = (until: string | null | undefined): string => until ?? new Date(Date.now() + COOL_DOWN_MS).toISOString();

/** `staffId` scopes a cashier's recent sales to their own; without one the read fails closed (never widens to all). */
const liveReads = (staffId: string | undefined): GatewayDeps['reads'] => ({
  'product.lookup': q => productLookup(q),
  'product.list': args => productList(args),
  'sales.recent': async (limit, scope) =>
    scope === 'all'
      ? recentSales(limit, 'all')
      : staffId
        ? recentSales(limit, { staffId })
        : err({ code: 'AUTH_FORBIDDEN' as const }),
  'expiry.list': d => expiryList(d),
  'stock.low': t => lowStock(t),
  'sales.summary': () => salesSummary(),
});

type PanelProps = {
  /** The manager PIN dialog, injected by the app router (a feature cannot import its sibling feature). */
  renderPinDialog: RenderPinDialog;
};

export function AssistantPanel({ renderPinDialog }: PanelProps) {
  const { t } = useTranslation('featMgmt');
  const queryClient = useQueryClient();
  const {
    isOpen,
    isBusy,
    messages,
    lockedUntil,
    close,
    addMessage,
    replaceReply,
    setBusy,
    setLockedUntil,
    clearMessages,
    restoreMessages,
  } = useAssistantPanelStore();
  const staffId = useStaffStore(s => s.currentStaff?.id);
  const userRole = useStaffStore(s => s.currentStaff?.role ?? 'cashier');
  const { can } = usePermissions();
  const { data: status } = useAssistantStatus();
  // Hidden (not a locked upsell) when the license lacks the entitlement; called above every early return.
  const { enabled: featureEnabled } = useFeature('ai_assistant');
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Closing the panel cancels the in-flight turn.
  useEffect(() => {
    if (!isOpen) abortRef.current?.abort();
  }, [isOpen]);

  // A different signed-in staff member never sees (or continues) the previous one's chat; their own recent chat
  // comes back from local history (D-19). Signing out or the idle lock (no staff) leaves the chat empty.
  useEffect(() => {
    restoreMessages(useAssistantHistory.getState().bind(staffId));
    return () => {
      abortRef.current?.abort();
      clearMessages();
    };
  }, [staffId, clearMessages, restoreMessages]);

  // The 50 message / 7 day cap is re-applied whenever the panel opens.
  useEffect(() => {
    if (isOpen) useAssistantHistory.getState().prune();
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isBusy, isOpen]);

  const ready = status?.state === 'ready' && featureEnabled;

  // D-15: read the cool-down whenever the panel opens. A gate that cannot be read leaves the state as it was; every
  // turn runs the gate again and fails closed, so this only decides what the panel shows.
  useEffect(() => {
    if (!isOpen || !ready) return;
    let live = true;
    void assistantGate().then(g => {
      if (live && g.ok) setLockedUntil(g.data.locked ? lockEnd(g.data.until) : null);
    });
    return () => {
      live = false;
    };
  }, [isOpen, ready, setLockedUntil]);

  // Re-check when the lock should have ended (the server clock decides: if it is still locked, look again in 5 s).
  useEffect(() => {
    if (lockedUntil === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      void assistantGate().then(g => {
        if (cancelled) return;
        if (g.ok && g.data.locked) {
          timer = setTimeout(check, 5_000);
          return;
        }
        setLockedUntil(null);
      });
    };
    timer = setTimeout(check, Math.max(0, Date.parse(lockedUntil) - Date.now()) + 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lockedUntil, setLockedUntil]);

  if (!ready) return null;

  const writes: WriteDeps = {
    gate: () => assistantGate(),
    stage: input => stageProposal(input),
    approve: input => approveProposal(input),
    cancel: (id, reason) => cancelProposal(id, reason),
    applyPrices: (id, items) => applyPriceBatch(id, items),
    recordRejection: (code, kind) => recordRejection(code, kind),
    terminalId: getTerminalId(),
    modelTag: modelTag(status),
  };

  const showReply = (reply: Awaited<ReturnType<typeof runTurn>>) => {
    if (reply.type === 'cancelled') return;
    // Money data (the sales summary) and staged writes are never persisted to per-staff history (D-19, Plan 29-06).
    const ephemeral =
      (reply.type === 'result' && (reply.kind === 'sales.summary' || reply.kind === 'sales.recent')) ||
      reply.type === 'preview' ||
      reply.type === 'choose-products' ||
      reply.type === 'outcome';
    addMessage(ephemeral ? { role: 'assistant', reply, persist: false } : { role: 'assistant', reply });
  };

  const send = async () => {
    const value = text.trim();
    if (value === '' || isBusy || lockedUntil !== null) return;
    setText('');
    const screened = screenInput(value);
    addMessage({ role: 'user', text: screened.ok ? screened.text : screened.redacted });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    try {
      const reply = await runTurn(value, {
        model: localModel,
        reads: liveReads(staffId),
        can,
        writes,
        onLocked: until => { setLockedUntil(lockEnd(until)); },
        signal: ctrl.signal,
      });
      if (reply.type === 'refusal' && reply.code === 'ASSISTANT_LOCKED') setLockedUntil(lockEnd(reply.until));
      showReply(reply);
    } finally {
      setBusy(false);
    }
  };

  // A typed supplier choice re-runs only the read for that supplier: no model turn, no rate-limit slot.
  const choose = async (supplierId: string) => {
    if (isBusy) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    try {
      showReply(await runChoice(supplierId, { model: localModel, reads: liveReads(staffId), can, signal: ctrl.signal }));
    } finally {
      setBusy(false);
    }
  };

  // The PIN ticket was issued: the server executes the staged batch; the preview card is replaced by the result.
  const approve = async (messageId: number, preview: PreviewReply, approverId: string, approvalId: string) => {
    if (isBusy) return;
    setBusy(true);
    try {
      const reply = await runApproval(preview, approverId, approvalId, { writes });
      invalidateAfterWrite(queryClient, preview, reply);
      replaceReply(messageId, reply);
    } finally {
      setBusy(false);
    }
  };

  const cancelPreview = async (messageId: number, preview: PreviewReply, reason: 'user' | 'expired') => {
    const reply = await runCancel(preview, reason, { writes });
    if (reply) replaceReply(messageId, reply);
  };

  // A product picked for an ambiguous item: no model turn; the batch is staged once every item is resolved.
  const chooseProduct = async (messageId: number, pending: PendingBatch, itemIndex: number, productId: string) => {
    if (isBusy) return;
    setBusy(true);
    try {
      replaceReply(messageId, await runBatchChoice(pending, itemIndex, productId, { writes }));
    } finally {
      setBusy(false);
    }
  };

  const previewOf = (messageId: number): PreviewReply | null => {
    const m = messages.find(msg => msg.id === messageId);
    return m?.role === 'assistant' && m.reply.type === 'preview' ? m.reply : null;
  };

  const writeProps = {
    busy: isBusy,
    renderPinDialog,
    onApprove: (id: number, approverId: string, approvalId: string) => {
      const preview = previewOf(id);
      if (preview) void approve(id, preview, approverId, approvalId);
    },
    onCancel: (id: number, reason: 'user' | 'expired') => {
      const preview = previewOf(id);
      if (preview) void cancelPreview(id, preview, reason);
    },
    onChooseProduct: (id: number, itemIndex: number, productId: string) => {
      const m = messages.find(msg => msg.id === id);
      if (m?.role === 'assistant' && m.reply.type === 'choose-products') {
        void chooseProduct(id, m.reply.pending, itemIndex, productId);
      }
    },
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const lockLine = lockedUntil === null ? null : present({ type: 'refusal', code: 'ASSISTANT_LOCKED', until: lockedUntil });

  return (
    <div
      role="dialog"
      aria-label={t('assistant.ariaLabel')}
      aria-modal="false"
      className={`fixed right-0 top-0 z-50 flex h-dvh w-full flex-col border-l border-border bg-popover text-popover-foreground shadow-2xl transition-transform ease-out-expo md:w-[400px] ${
        isOpen ? 'translate-x-0 duration-400' : 'translate-x-full duration-300'
      }`}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand-soft text-brand-strong">
            <Sparkles className="size-4" aria-hidden="true" />
          </span>
          <span className="font-semibold tracking-tight text-foreground">{t('assistant.title')}</span>
          <Badge variant="muted" className="capitalize">
            {userRole}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          aria-label={t('assistant.closeAria')}
          className="size-9 rounded-full text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto py-2">
        {messages.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('assistant.hint')}</p>
        )}
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} onChoose={id => { void choose(id); }} write={writeProps} />
        ))}
        {isBusy && (
          <div className="flex justify-start px-3 py-1">
            <div className="rounded-2xl rounded-bl-md border border-border bg-card shadow-xs">
              <TypingIndicator />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-border p-2">
        {lockedUntil !== null && (
          <p
            role="status"
            data-testid="assistant-lockout"
            className="mb-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-strong"
          >
            {lockLine && t(lockLine.key, lockLine.params)}
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={e => {
              setText(e.target.value);
            }}
            onKeyDown={onKeyDown}
            disabled={isBusy || lockedUntil !== null}
            aria-label={t('assistant.inputAria')}
            placeholder={t('assistant.placeholder')}
            rows={1}
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-input bg-card px-3.5 py-2.5 text-sm text-foreground shadow-xs placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-3 focus:ring-ring/25 disabled:opacity-50 dark:bg-input/20"
            style={{ maxHeight: '120px', overflowY: 'auto' }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              void send();
            }}
            disabled={isBusy || lockedUntil !== null || !text.trim()}
            aria-label={t('assistant.sendAria')}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-foreground shadow-xs transition-colors hover:bg-brand-strong disabled:opacity-50"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
