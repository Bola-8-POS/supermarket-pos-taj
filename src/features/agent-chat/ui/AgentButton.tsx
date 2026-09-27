import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStaffStore } from '@entities/staff/model/store';
import { cn } from '@shared/lib/utils';
import { LockedFeature } from '@shared/ui/LockedFeature';
import { Button } from '@shared/ui/button';
import { useAgentStore } from '../model/agentStore';

export function AgentButton({ className }: { className?: string }) {
  const { t } = useTranslation('featMgmt');
  const toggle = useAgentStore(s => s.toggle);
  const hasUnread = useAgentStore(s => s.hasUnread);
  const userRole = useStaffStore(s => s.currentStaff?.role ?? 'cashier');

  const agentEnabled = import.meta.env['VITE_AGENT_ENABLED'] as string | undefined;
  if (agentEnabled === 'false') return null;
  // The AI assistant is admin/manager only.
  if (userRole !== 'admin' && userRole !== 'manager') return null;

  return (
    <LockedFeature feature="ai_assistant">
      <Button
        type="button"
        variant="ghost"
        onClick={toggle}
        aria-label={t('agentChat.openAssistantAria')}
        size="icon-xs"
        className={cn('relative text-sidebar-muted hover:text-brand', className)}
      >
        {hasUnread && (
          <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-brand animate-pulse-soft" />
        )}
        <Sparkles className="size-4" aria-hidden="true" />
      </Button>
    </LockedFeature>
  );
}
