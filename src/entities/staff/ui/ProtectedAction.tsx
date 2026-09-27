import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { rbacDenialMessage, type StaffAction } from '@shared/lib/rbac';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@shared/ui/tooltip';

export type ProtectedActionProps = {
  action: StaffAction;
  /** Extra disable (e.g. no orders) combined with RBAC via OR. */
  disabled?: boolean;
  children: ReactNode;
};

function isReactElement(node: ReactNode): node is ReactElement<{ disabled?: boolean }> {
  return isValidElement(node);
}

/**
 * If the signed-in staff member lacks the action (per `usePermissions()`,
 * sourced from the live `role_permissions` matrix — a manager-PIN session
 * grant also unlocks it): disables the child control and shows a tooltip.
 * Otherwise renders the child with optional `disabled` merged in.
 */
export function ProtectedAction({ action, disabled = false, children }: ProtectedActionProps) {
  const { can } = usePermissions();
  const allowed = can(action);
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
