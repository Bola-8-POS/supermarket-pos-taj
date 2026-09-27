import { Sparkles, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStaffStore } from '@entities/staff/model/store';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { useAgentStore } from '../model/agentStore';
import { useAgent } from '../model/useAgent';
import { CommandChips } from './CommandChips';
import { ConfirmActionCard } from './ConfirmActionCard';
import { FileDropZone } from './FileDropZone';
import { ImportPreviewTable } from './ImportPreviewTable';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';

export function AgentPanel() {
  const { t } = useTranslation('featMgmt');
  const {
    isOpen,
    messages,
    isTyping,
    close,
    sendMessage,
    handleFileImport,
    pendingImportProducts,
    confirmImport,
    pendingConfirmation,
    confirmAction,
    cancelAction,
  } = useAgent();
  const setPendingImportProducts = useAgentStore(s => s.setPendingImportProducts);

  // AgentPanel only mounts once router.tsx confirms an authenticated staff
  // session, so currentStaff is always set here — the fallback only satisfies
  // the nullable store type.
  const userRole = useStaffStore(s => s.currentStaff?.role ?? 'cashier');
  const bottomRef = useRef<HTMLDivElement>(null);

  const agentEnabled = import.meta.env['VITE_AGENT_ENABLED'] as string | undefined;

  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isTyping, isOpen]);

  if (agentEnabled === 'false') return null;
  // The AI assistant is admin/manager only.
  if (userRole !== 'admin' && userRole !== 'manager') return null;

  const handleFileDrop = (file: File) => {
    void handleFileImport(file);
  };

  return (
    <div
      role="dialog"
      aria-label={t('agentChat.assistantAria')}
      aria-modal="false"
      className={`fixed right-0 top-0 z-50 flex h-dvh w-full flex-col border-l border-border bg-popover text-popover-foreground shadow-2xl transition-transform ease-out-expo md:w-[400px] ${
        isOpen ? 'translate-x-0 duration-400' : 'translate-x-full duration-300'
      }`}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand-soft text-brand-strong">
            <Sparkles className="size-4" aria-hidden="true" />
          </span>
          <span className="font-semibold tracking-tight text-foreground">
            {t('agentChat.assistantTitle')}
          </span>
          <Badge variant="muted" className="capitalize">
            {userRole}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          aria-label={t('agentChat.closeAssistantAria')}
          className="size-9 rounded-full text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* Messages area */}
      <div className="flex flex-1 flex-col overflow-y-auto py-2">
        {messages.length === 0 && (
          <CommandChips
            onSelect={text => {
              void sendMessage(text);
            }}
            userRole={userRole}
          />
        )}
        {messages.map((msg, idx) => (
          <MessageBubble key={idx} message={msg} />
        ))}
        {isTyping && (
          <div className="flex justify-start px-3 py-1">
            <div className="rounded-2xl rounded-bl-md border border-border bg-card shadow-xs">
              <TypingIndicator />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Destructive action confirmation */}
      {pendingConfirmation !== null && (
        <div className="shrink-0 px-3 pb-2">
          <ConfirmActionCard
            pending={pendingConfirmation}
            onConfirm={() => {
              void confirmAction(pendingConfirmation.token);
            }}
            onCancel={() => {
              void cancelAction(pendingConfirmation.token);
            }}
            isLoading={isTyping}
          />
        </div>
      )}

      {/* Import preview */}
      {pendingImportProducts !== null && pendingImportProducts.length > 0 && (
        <div className="shrink-0 px-3 pb-2">
          <ImportPreviewTable
            products={pendingImportProducts}
            onConfirm={() => {
              void confirmImport();
            }}
            onCancel={() => {
              setPendingImportProducts(null);
            }}
            isLoading={isTyping}
          />
        </div>
      )}

      {/* Input area */}
      <div className="shrink-0">
        <FileDropZone
          onSend={text => {
            void sendMessage(text);
          }}
          onFileDrop={handleFileDrop}
          disabled={isTyping}
        />
      </div>
    </div>
  );
}
