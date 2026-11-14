import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/utils';
import { LockedFeature } from '@shared/ui/LockedFeature';
import { Button } from '@shared/ui/button';
import { useAssistantPanelStore } from '../model/panelStore';
import { useAssistantStatus } from '../model/useAssistantStatus';

/** Entry point. Hidden unless the local assistant is ready (and running under Tauri); every role may use it. */
export function AssistantButton({ className }: { className?: string }) {
  const { t } = useTranslation('featMgmt');
  const toggle = useAssistantPanelStore(s => s.toggle);
  const { data } = useAssistantStatus();

  if (data?.state !== 'ready') return null;

  return (
    <LockedFeature feature="ai_assistant">
      <Button
        type="button"
        variant="ghost"
        onClick={toggle}
        aria-label={t('assistant.openAria')}
        size="icon-xs"
        className={cn('relative text-sidebar-muted hover:text-brand', className)}
      >
        <Sparkles className="size-4" aria-hidden="true" />
      </Button>
    </LockedFeature>
  );
}
