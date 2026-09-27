import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLoginUiStore } from '@entities/staff/model/loginUiStore';
import { useStaffList } from '@entities/staff/model/queries';
import type { Staff } from '@entities/staff/model/types';
import { cn } from '@shared/lib/utils';
import { LoadingSpinner } from '@shared/ui/LoadingSpinner';
import { Button } from '@shared/ui/button';

/* eslint-disable i18next/no-literal-string -- Tailwind class-name lookup table keyed by role, not UI copy */
const ROLE_AVATAR: Record<string, string> = {
  admin: 'bg-primary text-primary-foreground',
  manager: 'bg-brand text-brand-foreground',
  cashier: 'bg-success-soft text-success-strong',
  kitchen: 'bg-warning-soft text-warning-strong',
};
/* eslint-enable i18next/no-literal-string */

export function EmployeeSelector() {
  const { t } = useTranslation('wPanels');
  const { data: staff, isLoading, error, resultError } = useStaffList();
  const hasError = Boolean(error || resultError);
  const errorMessage = resultError?.message ?? error?.message ?? t('employeeSelector.unknownError');
  const setSelectedStaff = useLoginUiStore(s => s.setSelectedStaff);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoadingSpinner />
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="rounded-2xl border border-destructive/20 bg-destructive-soft p-6 text-center text-sm text-destructive">
        {t('employeeSelector.failedToLoadStaff')} {errorMessage}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="space-y-1.5 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">{t('employeeSelector.whoAreYou')}</h2>
        <p className="text-sm text-muted-foreground">{t('employeeSelector.pickYourName')}</p>
      </div>
      <div className="max-h-[min(60vh,32rem)] overflow-y-auto rounded-2xl border border-border bg-card p-2 shadow-sm">
        <div className="flex flex-col gap-1">
          {(staff ?? []).map((member: Staff) => (
            <Button
              key={member.id}
              type="button"
              variant="ghost"
              onClick={() => {
                setSelectedStaff(member);
              }}
              className="group/staff flex h-auto w-full items-center justify-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-muted"
            >
              <div
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-full text-base font-semibold',
                  ROLE_AVATAR[member.role] ?? ROLE_AVATAR['cashier']
                )}
                aria-hidden="true"
              >
                {member.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[0.9375rem] font-medium">{member.name}</div>
                <div className="text-xs text-muted-foreground capitalize">{member.role}</div>
              </div>
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] duration-150 group-hover/staff:translate-x-0.5 group-hover/staff:opacity-100"
                aria-hidden="true"
              />
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
