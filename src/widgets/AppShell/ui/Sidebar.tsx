import {
  ChevronsLeft,
  ChevronsRight,
  Home,
  Lock,
  LogOut,
  ShoppingBasket,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AgentButton } from '@features/agent-chat';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import { useNearExpiryAlerts } from '@entities/inventory';
import { useReceiptSettings } from '@entities/settings';
import { useStaffStore } from '@entities/staff/model/store';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { NAV_GROUPS, NAV_ITEMS, type NavItem } from '@shared/config/navigation';
import { useOnlineStatus } from '@shared/lib/connectivity';
import { useNavFeatureLocked } from '@shared/lib/license/features';
import { confirmNavigation, useNavigationGuardStore } from '@shared/lib/navigation-guard';
import type { StaffAction } from '@shared/lib/rbac';
import { getTerminalId } from '@shared/lib/terminal';
import { cn } from '@shared/lib/utils';
import { LiveTimeDisplay } from '@shared/ui/LiveTimeDisplay';
import { Button } from '@shared/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@shared/ui/tooltip';

type GatedTarget = { action: StaffAction; path: string };

// Navigation from the sidebar must honour the page-installed guard (Settings
// installs one while a tab has unsaved changes). NavLink handles the default
// case; when a guard is installed we take over and navigate imperatively.
function useGuardedNavigate() {
  const navigate = useNavigate();
  return useCallback(
    async (to: string) => {
      if (await confirmNavigation()) void navigate(to);
    },
    [navigate]
  );
}

function BrandMark({ compact }: { compact: boolean }) {
  const { t } = useTranslation('wPanels');
  const { data } = useReceiptSettings();
  const logo = data?.logoDataUrl ?? null;

  return (
    <div className={cn('flex h-16 items-center gap-3 px-3', compact && 'justify-center px-0')}>
      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand text-brand-foreground shadow-sm">
        {logo ? (
          <img src={logo} alt={t('appShell.brand')} className="size-full object-cover" />
        ) : (
          <ShoppingBasket className="size-5" aria-hidden="true" />
        )}
      </div>
      {!compact && (
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold tracking-tight">{t('appShell.brand')}</p>
          <p className="truncate text-[0.6875rem] font-medium text-sidebar-muted">
            {t('appShell.terminal', { id: getTerminalId() })}
          </p>
        </div>
      )}
    </div>
  );
}

function NavEntry({
  item,
  compact,
  gated,
  badge,
  onGated,
}: {
  item: NavItem;
  compact: boolean;
  gated: boolean;
  badge: number | undefined;
  onGated: (target: GatedTarget) => void;
}) {
  const { t } = useTranslation('wPanels');
  const Icon = item.icon;
  const label = t(item.labelKey);
  const hasGuard = useNavigationGuardStore(s => s.guard !== null);
  const guardedNavigate = useGuardedNavigate();
  const { locked: featureLocked, requestUpgrade } = useNavFeatureLocked(item.feature);

  const link = (
    <NavLink
      to={item.path}
      onClick={event => {
        // RBAC wins over an entitlement lock: a role that can't reach this
        // item at all sees the existing manager-PIN flow, never upgrade copy.
        if (gated && item.requiredAction) {
          event.preventDefault();
          onGated({ action: item.requiredAction, path: item.path });
          return;
        }
        if (featureLocked) {
          event.preventDefault();
          requestUpgrade();
          return;
        }
        if (hasGuard) {
          event.preventDefault();
          void guardedNavigate(item.path);
        }
      }}
      className={({ isActive }) =>
        cn(
          'group/nav relative flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-sidebar-muted transition-[background-color,color] duration-150 outline-none select-none',
          'hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-ring/40',
          isActive && 'bg-sidebar-accent text-sidebar-foreground',
          compact && 'justify-center px-0'
        )
      }
      aria-label={label}
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-1/2 left-0 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-brand transition-[opacity,transform] duration-200',
              isActive ? 'opacity-100' : 'scale-y-0 opacity-0'
            )}
          />
          <Icon
            className={cn(
              'size-[1.125rem] shrink-0 transition-colors',
              isActive ? 'text-brand' : 'text-sidebar-muted group-hover/nav:text-sidebar-foreground'
            )}
            strokeWidth={isActive ? 2.25 : 2}
            aria-hidden="true"
          />
          <span className={cn('truncate', compact && 'sr-only')}>{label}</span>
          {!compact && badge !== undefined && badge > 0 && (
            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-warning-soft px-1.5 text-[0.6875rem] font-semibold text-warning-strong tabular-nums">
              {badge}
            </span>
          )}
          {(featureLocked || gated) && (
            <Lock
              className={cn(
                'size-3.5 shrink-0 text-sidebar-muted/70',
                compact ? 'absolute top-1.5 right-1.5 size-3' : 'ml-auto',
                !compact && badge !== undefined && badge > 0 && 'ml-2'
              )}
              aria-hidden="true"
              data-testid={gated ? 'nav-lock-icon' : 'nav-feature-lock-icon'}
            />
          )}
        </>
      )}
    </NavLink>
  );

  if (!compact) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
        {gated ? ` · ${t('appShell.managerRequired')}` : ''}
      </TooltipContent>
    </Tooltip>
  );
}

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Hide the collapse toggle (the rail is forced, e.g. on the checkout screen). */
  toggleHidden: boolean;
}

export function Sidebar({ collapsed, onToggle, toggleHidden }: SidebarProps) {
  const { t } = useTranslation('wPanels');
  const { can } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();
  const isOnline = useOnlineStatus();
  const currentStaff = useStaffStore(s => s.currentStaff);
  const currentShift = useStaffStore(s => s.currentShift);
  const logout = useStaffStore(s => s.logout);
  const grantManagerActions = useStaffStore(s => s.grantManagerActions);
  const { data: nearExpiryAlerts } = useNearExpiryAlerts();
  const [gatedTarget, setGatedTarget] = useState<GatedTarget | null>(null);
  const hasGuard = useNavigationGuardStore(s => s.guard !== null);
  const guardedNavigate = useGuardedNavigate();

  const shiftStart = currentShift
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
        new Date(currentShift.clockIn)
      )
    : null;

  function handleSignOut() {
    void (async () => {
      if (!(await confirmNavigation())) return;
      logout();
      void navigate('/login');
    })();
  }

  const homeLabel = t('appShell.home');
  // Not UI copy — kept as a variable (rather than inlined) purely so the
  // guardedNavigate(HOME_PATH) call below isn't a raw string-literal call
  // argument, which i18next/no-literal-string's `callees` check (mode: 'all')
  // otherwise flags on any callee not in its exclude list.
  const HOME_PATH = '/home';
  const isHome = location.pathname === HOME_PATH;

  return (
    <TooltipProvider delayDuration={150}>
      {/* Plain div, not <aside>: e2e specs address the checkout cart as the page's
          only <aside>, and the <nav> below already provides the landmark. */}
      <div
        data-testid="app-sidebar"
        data-collapsed={collapsed ? 'true' : 'false'}
        className={cn(
          'relative flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out-quart',
          collapsed ? 'w-[4.25rem]' : 'w-64'
        )}
      >
        <BrandMark compact={collapsed} />

        <nav
          aria-label={t('appShell.brand')}
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3',
            collapsed && 'px-3'
          )}
        >
          {/* Home */}
          <NavLink
            to={HOME_PATH}
            aria-label={homeLabel}
            onClick={event => {
              if (hasGuard) {
                event.preventDefault();
                void guardedNavigate(HOME_PATH);
              }
            }}
            className={cn(
              'group/nav relative flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-sidebar-muted transition-[background-color,color] duration-150 outline-none select-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-ring/40',
              isHome && 'bg-sidebar-accent text-sidebar-foreground',
              collapsed && 'justify-center px-0'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-1/2 left-0 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-brand transition-[opacity,transform] duration-200',
                isHome ? 'opacity-100' : 'scale-y-0 opacity-0'
              )}
            />
            <Home
              className={cn(
                'size-[1.125rem] shrink-0',
                isHome ? 'text-brand' : 'text-sidebar-muted group-hover/nav:text-sidebar-foreground'
              )}
              strokeWidth={isHome ? 2.25 : 2}
              aria-hidden="true"
            />
            <span className={cn('truncate', collapsed && 'sr-only')}>{homeLabel}</span>
          </NavLink>

          {NAV_GROUPS.map(group => {
            const items = NAV_ITEMS.filter(item => item.group === group.key);
            return (
              <div key={group.key} className="mt-3 flex flex-col gap-0.5">
                {!collapsed ? (
                  <p className="mb-1 px-3 text-[0.6563rem] font-semibold tracking-[0.12em] text-sidebar-muted/80 uppercase">
                    {t(group.labelKey)}
                  </p>
                ) : (
                  <div className="mx-3 mb-1 h-px bg-sidebar-border" aria-hidden="true" />
                )}
                {items.map(item => {
                  const gated = !!item.requiredAction && !can(item.requiredAction);
                  const badge =
                    item.path === '/inventory' && nearExpiryAlerts?.length
                      ? nearExpiryAlerts.length
                      : undefined;
                  return (
                    <NavEntry
                      key={item.path}
                      item={item}
                      compact={collapsed}
                      gated={gated}
                      badge={badge}
                      onGated={setGatedTarget}
                    />
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* Footer: staff + status */}
        <div className="border-t border-sidebar-border p-3">
          {currentStaff && (
            <div
              className={cn(
                'flex items-center gap-3 rounded-xl bg-sidebar-accent/60 p-2',
                collapsed && 'flex-col gap-2 p-1.5'
              )}
            >
              <div className="relative shrink-0">
                <div className="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {currentStaff.name.charAt(0).toUpperCase()}
                </div>
                <span
                  className={cn(
                    'absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-sidebar',
                    isOnline ? 'bg-success' : 'bg-warning'
                  )}
                  aria-hidden="true"
                />
              </div>
              {!collapsed && (
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate text-sm font-medium">{currentStaff.name}</p>
                  <p className="truncate text-[0.6875rem] text-sidebar-muted capitalize">
                    {currentStaff.role}
                    {shiftStart ? ` · ${t('appShell.onShiftSince', { time: shiftStart })}` : ''}
                  </p>
                </div>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-sidebar-muted hover:text-destructive"
                    onClick={handleSignOut}
                    aria-label={t('appShell.signOut')}
                  >
                    <LogOut className="size-4" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{t('appShell.signOut')}</TooltipContent>
              </Tooltip>
            </div>
          )}

          <div
            className={cn(
              'mt-2 flex items-center justify-between gap-2 px-1 text-[0.6875rem] text-sidebar-muted',
              collapsed && 'flex-col'
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {isOnline ? (
                <Wifi className="size-3.5 text-success" aria-hidden="true" />
              ) : (
                <WifiOff className="size-3.5 text-warning" aria-hidden="true" />
              )}
              {!collapsed && (isOnline ? t('appShell.online') : t('appShell.offline'))}
            </span>
            {!collapsed && <LiveTimeDisplay className="text-[0.6875rem] text-sidebar-muted" />}
            <AgentButton />
            {!toggleHidden && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-sidebar-muted"
                onClick={onToggle}
                aria-label={collapsed ? t('appShell.expand') : t('appShell.collapse')}
              >
                {collapsed ? (
                  <ChevronsRight className="size-3.5" aria-hidden="true" />
                ) : (
                  <ChevronsLeft className="size-3.5" aria-hidden="true" />
                )}
              </Button>
            )}
          </div>
        </div>

        <ManagerPinDialog
          open={gatedTarget !== null}
          onOpenChange={open => {
            if (!open) setGatedTarget(null);
          }}
          requiredAction={gatedTarget?.action ?? 'view_reports'}
          onSuccess={() => {
            if (!gatedTarget) return;
            grantManagerActions([gatedTarget.action]);
            const path = gatedTarget.path;
            setGatedTarget(null);
            void guardedNavigate(path);
          }}
        />
      </div>
    </TooltipProvider>
  );
}
