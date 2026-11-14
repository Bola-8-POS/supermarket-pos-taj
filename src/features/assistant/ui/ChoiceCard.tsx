import { useTranslation } from 'react-i18next';
import { formatMoney } from '@shared/lib/format';
import type { PendingBatch } from '@shared/lib/local-assistant/presenter';
import { Button } from '@shared/ui/button';

type Props = {
  pending: PendingBatch;
  busy: boolean;
  /** Tapping a candidate resolves that one item; the batch is staged once every item is resolved. */
  onChoose: (itemIndex: number, productId: string) => void;
};

/**
 * One group of buttons per item whose wording matched several products (D-09). Candidates are database rows read on
 * the caller's session; the item label is shown only when the staff typed it, otherwise the item's position.
 */
export function ChoiceCard({ pending, busy, onChoose }: Props) {
  const { t } = useTranslation('featMgmt');
  return (
    <div data-testid="assistant-choice-card" className="mx-3 my-1 rounded-xl border border-border bg-card p-3 text-sm">
      <p className="mb-2 font-medium text-card-foreground">{t('assistant.adjust.chooseTitle')}</p>
      {pending.items.map((item, index) =>
        item.chosenId === null && item.candidates.length > 1 ? (
          <fieldset key={index} className="mb-2 last:mb-0" data-testid="assistant-choice-item">
            <legend className="mb-1 text-xs text-muted-foreground">
              {item.label === null
                ? t('assistant.adjust.chooseItemNumbered', { n: index + 1 })
                : t('assistant.adjust.chooseItem', { label: item.label })}
            </legend>
            <div className="flex flex-wrap gap-2">
              {item.candidates.map(candidate => (
                <Button
                  key={candidate.productId}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  data-testid="assistant-product-choice"
                  onClick={() => {
                    onChoose(index, candidate.productId);
                  }}
                >
                  {pending.kind === 'product.price'
                    ? t('assistant.price.choiceOption', { name: candidate.name, price: formatMoney(candidate.price) })
                    : t('assistant.adjust.choiceOption', { name: candidate.name, stock: candidate.quantityOnHand ?? 0 })}
                </Button>
              ))}
            </div>
          </fieldset>
        ) : null
      )}
    </div>
  );
}
