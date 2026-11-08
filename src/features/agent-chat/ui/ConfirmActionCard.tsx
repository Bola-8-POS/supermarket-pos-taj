import { AlertTriangle, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PendingConfirmation } from '@shared/lib/agent/brain';
import { Button } from '@shared/ui/button';

interface Props {
  pending: PendingConfirmation;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
}

const TOOL_LABEL_KEYS = new Set([
  'close_tab',
  'stop_pool_session',
  'stop_and_move_table',
  'deactivate_product',
  'bulk_import_products',
]);

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function renderPreview(preview: unknown): React.ReactNode {
  if (!preview || typeof preview !== 'object') return null;
  const entries = Object.entries(preview as Record<string, unknown>).filter(
    ([k]) => k !== 'action'
  );
  return entries.map(([k, v]) => <PreviewRow key={k} label={k} value={String(v)} />);
}

export function ConfirmActionCard({ pending, onConfirm, onCancel, isLoading }: Props) {
  const { t } = useTranslation('featMgmt');
  const label = TOOL_LABEL_KEYS.has(pending.toolName)
    ? t(`agentChat.toolLabels.${pending.toolName}`)
    : pending.toolName;

  return (
    <div className="mx-3 mb-2 rounded-xl border border-warning/40 bg-warning-soft p-3">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-warning-strong" />
        <span className="text-sm font-semibold text-warning-strong">{label}</span>
      </div>

      <div className="mb-3 divide-y divide-border/40 rounded-lg bg-background/60 px-3 py-1">
        {renderPreview(pending.preview)}
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          className="flex-1 gap-1"
          onClick={onConfirm}
          disabled={isLoading}
        >
          <Check className="size-3.5" />
          {t('agentChat.confirm')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1"
          onClick={onCancel}
          disabled={isLoading}
        >
          <X className="size-3.5" />
          {t('agentChat.cancel')}
        </Button>
      </div>
    </div>
  );
}
