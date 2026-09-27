import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { canAccess, rbacDenialMessage, type StaffAction, type StaffRole } from '@shared/lib/rbac';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

export type ProtectedActionProps = {
  action: StaffAction;
  currentRole: StaffRole | null | undefined;
  /** Extra disable (e.g. no orders) combined with RBAC via OR. */
  disabled?: boolean;
  children: ReactNode;
};

function isReactElement(node: ReactNode): node is ReactElement<{ disabled?: boolean }> {
  return isValidElement(node);
}

/**
 * If the role lacks permission: disables the child control and shows a tooltip.
 * Otherwise renders the child with optional `disabled` merged in.
 */
export function ProtectedAction({
  action,
  currentRole,
  disabled = false,
  children,
}: ProtectedActionProps) {
  const allowed = canAccess(currentRole, action);
  const denialMessage = rbacDenialMessage(action);

  if (!isReactElement(children)) {
    return <>{children}</>;
  }

  const mergedDisabled = Boolean(disabled || children.props.disabled);

  if (allowed) {
    if (mergedDisabled === Boolean(children.props.disabled)) {
      return children;
    }
    return cloneElement(children, { disabled: mergedDisabled });
  }

  const deniedChild = cloneElement(children, { disabled: true });

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex max-w-full cursor-not-allowed">{deniedChild}</span>
        </TooltipTrigger>
        <TooltipContent side="top">{denialMessage}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
