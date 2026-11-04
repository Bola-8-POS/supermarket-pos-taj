import { Lock } from 'lucide-react';
import { cloneElement, isValidElement, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeature, type FeatureKey } from '@shared/lib/license/features';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

export type LockedFeatureProps = {
  feature: FeatureKey;
  /** Extra disable combined with the entitlement via OR (same contract as ProtectedAction). */
  disabled?: boolean;
  children: ReactNode;
};

function isReactElement(node: ReactNode): node is ReactElement<{ disabled?: boolean }> {
  return isValidElement(node);
}

/**
 * Entitlement gate for one control. Enabled → renders the child (merging `disabled`).
 * Locked (demo / plan without this feature) → child disabled + lock badge + tooltip; tapping
 * the wrapper opens the global UpgradeDialog for this feature.
 */
export function LockedFeature({ feature, disabled = false, children }: LockedFeatureProps) {
  const { t } = useTranslation('common');
  const { enabled, requestUpgrade } = useFeature(feature);

  if (!isReactElement(children)) return <>{children}</>;

  const mergedDisabled = Boolean(disabled || children.props.disabled);
  if (enabled) {
    return mergedDisabled === Boolean(children.props.disabled)
      ? children
      : cloneElement(children, { disabled: mergedDisabled });
  }

  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      requestUpgrade();
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            aria-label={`${t(`license.features.${feature}`)} — ${t('license.locked.tooltip')}`}
            data-testid="locked-feature"
            data-feature={feature}
            className="relative inline-flex max-w-full cursor-pointer"
            onClick={requestUpgrade}
            onKeyDown={onKey}
          >
            {cloneElement(children, { disabled: true })}
            {/* A disabled native control (Radix Switch renders a real <button disabled>,
                and disabled form controls dispatch no click/pointer events at all) would
                otherwise swallow the click before it ever reaches this wrapper's handler.
                This transparent overlay sits on top and is what the pointer actually hits. */}
            <span
              aria-hidden="true"
              data-testid="locked-feature-overlay"
              className="absolute inset-0 z-10 cursor-pointer"
            />
            <Lock
              aria-hidden="true"
              className="pointer-events-none absolute -top-1 -right-1 size-3.5 rounded-full bg-warning p-0.5 text-warning-foreground"
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{t('license.locked.tooltip')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
