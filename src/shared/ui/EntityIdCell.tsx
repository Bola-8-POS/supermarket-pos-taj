import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

import { cn } from '@shared/lib/utils';
import { Button } from './button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

export type EntityIdCellProps = {
  entityType: string;
  entityId: string | undefined;
  className?: string;
};

/** Entity types that get a real navigation link (D-01/D-02); everything else is copy-only text. */
const LINKABLE_TYPES = new Set(['payment', 'tab', 'staff']);

const COPIED_RESET_MS = 1500;

/**
 * Shared shared/ui primitive: renders an entity ID as a navigation link
 * (payment/tab -> /payments?id=, staff -> /staff?id=) or plain copy-only
 * text for every other entityType, plus a copy-to-clipboard button and a
 * full-ID tooltip. See 10-05-PLAN.md (D-01..D-04).
 */
export function EntityIdCell({ entityType, entityId, className }: EntityIdCellProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  if (!entityId) {
    return <span className={cn('text-xs text-muted-foreground', className)}>—</span>;
  }

  const truncated = entityId.slice(0, 8);
  const isLinkable = LINKABLE_TYPES.has(entityType);
  const isStaff = entityType === 'staff';
  const route = isStaff
    ? `/staff?id=${encodeURIComponent(entityId)}`
    : `/payments?id=${encodeURIComponent(entityId)}`;
  const ariaLabel = isStaff
    ? t('wAdmin:viewStaffAriaLabel', { id: truncated })
    : t('wAdmin:viewPaymentAriaLabel', { id: truncated });

  const idElement = isLinkable ? (
    <Link
      to={route}
      aria-label={ariaLabel}
      className="font-mono text-xs text-primary underline-offset-4 hover:underline"
    >
      {truncated}
    </Link>
  ) : (
    <span className="font-mono text-xs text-muted-foreground">{truncated}</span>
  );

  const handleCopy = () => {
    if (!('clipboard' in navigator)) {
      toast.error(t('common:copyIdFailed'));
      return;
    }
    navigator.clipboard
      .writeText(entityId)
      .then(() => {
        setCopied(true);
        toast.success(t('common:idCopied'));
        setTimeout(() => {
          setCopied(false);
        }, COPIED_RESET_MS);
      })
      .catch(() => {
        toast.error(t('common:copyIdFailed'));
      });
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>{idElement}</TooltipTrigger>
          <TooltipContent side="top">{entityId}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="min-h-11 min-w-11"
        aria-label={t('common:copyId')}
        data-testid="copy-entity-id-button"
        onClick={handleCopy}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
