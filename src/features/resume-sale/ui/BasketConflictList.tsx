import { useTranslation } from 'react-i18next';
import { formatMoney } from '@shared/lib/format';
import { Button } from '@shared/ui/button';
import type { BasketConflict } from '../model/basketConflicts';

export interface BasketConflictListProps {
  conflicts: ReadonlyArray<BasketConflict>;
  acceptedKeys: ReadonlySet<string>;
  onAccept: (key: string) => void;
  onRemoveLine: (lineId: string) => void;
}

/** D-03: saved versus current for every changed restored line; the cashier accepts or removes each. */
export function BasketConflictList({ conflicts, acceptedKeys, onAccept, onRemoveLine }: BasketConflictListProps) {
  const { t } = useTranslation('wPanels');

  const show = (conflict: BasketConflict, value: number | null): string => {
    if (conflict.kind === 'unavailable') return value === null ? t('resumeSale.conflict.unavailable') : '';
    if (value === null) return '';
    return conflict.kind === 'stock' ? String(value) : formatMoney(value / 100);
  };

  return (
    <section
      aria-labelledby="basket-conflict-heading"
      className="max-h-64 shrink-0 space-y-2 overflow-y-auto border-b border-warning/40 bg-warning/10 px-4 py-3"
    >
      <h2 id="basket-conflict-heading" className="text-sm font-semibold">
        {t('resumeSale.conflict.title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('resumeSale.conflict.guidance')}</p>
      <ul className="space-y-2">
        {conflicts.map(conflict => {
          const accepted = acceptedKeys.has(conflict.key);
          return (
            <li
              key={conflict.key}
              data-testid="basket-conflict"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/60 bg-background px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{conflict.productName}</p>
                <p className="text-xs text-muted-foreground">{t(`resumeSale.conflict.${conflict.kind}`)}</p>
              </div>
              {conflict.kind !== 'unavailable' && (
                <p className="text-xs">
                  <span className="text-muted-foreground">{t('resumeSale.conflict.saved')}: </span>
                  <span data-testid="conflict-saved">{show(conflict, conflict.saved)}</span>
                </p>
              )}
              <p className="text-xs">
                {conflict.kind !== 'unavailable' && (
                  <span className="text-muted-foreground">{t('resumeSale.conflict.current')}: </span>
                )}
                <span data-testid="conflict-current">{show(conflict, conflict.current)}</span>
              </p>
              {conflict.kind !== 'unavailable' && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={accepted}
                  onClick={() => {
                    onAccept(conflict.key);
                  }}
                >
                  {accepted ? t('resumeSale.conflict.accepted') : t('resumeSale.conflict.accept')}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => {
                  onRemoveLine(conflict.lineId);
                }}
              >
                {t('resumeSale.conflict.removeLine')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
