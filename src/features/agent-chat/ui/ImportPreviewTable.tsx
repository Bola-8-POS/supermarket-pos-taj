import { useTranslation } from 'react-i18next';
import { formatMoney } from '@shared/lib/format';
import { Button } from '@shared/ui/button';

interface ImportPreviewTableProps {
  products: Array<{ name: string; price: number }>;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
}

const MAX_DISPLAY = 20;

export function ImportPreviewTable({
  products,
  onConfirm,
  onCancel,
  isLoading,
}: ImportPreviewTableProps) {
  const { t } = useTranslation('featMgmt');
  const displayed = products.slice(0, MAX_DISPLAY);
  const remaining = products.length - MAX_DISPLAY;

  return (
    <div data-testid="agent-import-preview" className="rounded-lg border border-border bg-card p-3">
      <p className="mb-2 text-sm font-medium text-foreground">
        {t('agentChat.previewTitle', {
          count: products.length,
          plural: products.length !== 1 ? 's' : '',
        })}
      </p>
      <div className="max-h-48 overflow-y-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="pb-1 text-left font-medium text-muted-foreground">
                {t('agentChat.nameHeader')}
              </th>
              <th className="pb-1 text-right font-medium text-muted-foreground">
                {t('agentChat.priceHeader')}
              </th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((p, idx) => (
              <tr key={idx} className="border-b border-border/50 last:border-0">
                <td className="py-1 text-left text-foreground">{p.name}</td>
                <td className="py-1 text-right text-foreground">
                  {formatMoney(p.price)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {remaining > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('agentChat.andMore', { count: remaining })}
          </p>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          onClick={onConfirm}
          disabled={isLoading}
          className="flex-1"
        >
          {isLoading ? t('agentChat.importing') : t('agentChat.confirmImport')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={isLoading}
        >
          {t('agentChat.cancel')}
        </Button>
      </div>
    </div>
  );
}
