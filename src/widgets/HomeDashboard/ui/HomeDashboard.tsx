import { ArrowRight, Lock, LogOut } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import { useNearExpiryAlerts } from '@entities/inventory';
import { useStaffStore } from '@entities/staff/model/store';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { NAV_GROUPS, NAV_ITEMS, type NavItem } from '@shared/config/navigation';
import { useNavFeatureLocked } from '@shared/lib/license/features';
import type { StaffAction } from '@shared/lib/rbac';
import { cn } from '@shared/lib/utils';
import { Badge, Button } from '@shared/ui';
import { LiveTimeDisplay } from '@shared/ui/LiveTimeDisplay';

type GatedTarget = { action: StaffAction; path: string };

/** Typographic separator between meta segments (decorative, not copy). */
function Dot() {
  return <span aria-hidden="true" className="size-1 rounded-full bg-muted-foreground/50" />;
}

/**
 * One nav tile. A real component (not a plain render helper) so
 * `useNavFeatureLocked` is called once per item with a stable hook count.
 */
function Tile({
  item,
  index,
  isGated,
  badge,
  onClick,
}: {
  item: NavItem;
  index: number;
  isGated: boolean;
  badge: number | undefined;
  onClick: (item: NavItem) => void;
}) {
  const { t } = useTranslation('wPanels');
  const { locked: featureLocked, requestUpgrade } = useNavFeatureLocked(item.feature);
  const Icon = item.icon;
  const itemLabel = t(item.labelKey);
  const showLock = isGated || featureLocked;

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => {
        // RBAC wins over an entitlement lock: a role that can't reach this
        // tile at all gets the existing manager-PIN flow (via onClick below),
        // never upgrade copy.
        if (!isGated && featureLocked) {
          requestUpgrade();
          return;
        }
        onClick(item);
      }}
      style={{ animationDelay: `${String(40 + index * 30)}ms` }}
      className={cn(
        'group/tile relative flex h-auto min-h-[8.5rem] flex-col items-start justify-between gap-4 rounded-2xl border border-border bg-card p-4 text-left shadow-xs animate-fade-up',
        'transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out-quart',
        'hover:-translate-y-0.5 hover:border-border-strong hover:bg-card hover:shadow-md',
        'focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none'
      )}
      aria-label={itemLabel}
      data-testid={item.path === '/audit' ? 'home-tile-audit' : undefined}
    >
      <div className="flex w-full items-start justify-between">
        <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-foreground transition-colors duration-200 group-hover/tile:bg-brand-soft group-hover/tile:text-brand-strong">
          <Icon className="size-5" strokeWidth={2} aria-hidden="true" />
        </div>
        <div className="flex items-center gap-1.5">
          {badge !== undefined && badge > 0 ? (
            <Badge variant="warning" data-testid="home-near-expiry-badge">
              {badge}
            </Badge>
          ) : null}
          {showLock && (
            <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Lock
                className="size-3.5"
                aria-hidden="true"
                data-testid={isGated ? 'lock-icon' : 'home-tile-feature-lock-icon'}
              />
            </span>
          )}
        </div>
      </div>
      <div className="flex w-full items-end justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <span className="block truncate text-[0.9375rem] font-semibold tracking-tight">
            {itemLabel}
          </span>
          {isGated && item.managerLabelKey && (
            <Badge variant="muted" className="h-5 px-1.5 text-[0.6563rem] tracking-wide uppercase">
              {t(item.managerLabelKey)}
            </Badge>
          )}
        </div>
        <ArrowRight
          className="size-4 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] duration-200 group-hover/tile:translate-x-0.5 group-hover/tile:opacity-100"
          aria-hidden="true"
        />
      </div>
    </Button>
  );
}

export function HomeDashboard() {
  const { t, i18n } = useTranslation('wPanels');
  const { can } = usePermissions();
  const navigate = useNavigate();
  const currentStaff = useStaffStore(s => s.currentStaff);
  const logout = useStaffStore(s => s.logout);
  const grantManagerActions = useStaffStore(s => s.grantManagerActions);
  const [gatedTarget, setGatedTarget] = useState<GatedTarget | null>(null);
  const { data: nearExpiryAlerts } = useNearExpiryAlerts();

  const todayLabel = new Intl.DateTimeFormat(i18n.language, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());

  function handleItemClick(item: NavItem) {
    if (!item.requiredAction || can(item.requiredAction)) {
      void navigate(item.path);
    } else {
      setGatedTarget({ action: item.requiredAction, path: item.path });
    }
  }

  function handleLogout() {
    logout();
    void navigate('/login');
  }

  const posItem = NAV_ITEMS.find(item => item.path === '/pos');
  const PosIcon = posItem?.icon;

  function renderTile(item: NavItem, index: number) {
    const isGated = !!item.requiredAction && !can(item.requiredAction);
    const badge =
      item.path === '/inventory' && nearExpiryAlerts?.length ? nearExpiryAlerts.length : undefined;
    return (
      <Tile
        key={item.path}
        item={item}
        index={index}
        isGated={isGated}
        badge={badge}
        onClick={handleItemClick}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 lg:p-10">
      {/* Greeting */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-x-2 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            <span>{t('homeDashboard.today')}</span>
            <Dot />
            <span className="capitalize">{todayLabel}</span>
            <Dot />
            <LiveTimeDisplay className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase" />
          </p>
          {currentStaff && (
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight">
                {t('homeDashboard.welcome', { name: currentStaff.name })}
              </h1>
              <Badge variant="brand" className="capitalize">
                {currentStaff.role}
              </Badge>
            </div>
          )}
        </div>
        <Button variant="outline" onClick={handleLogout}>
          <LogOut className="size-4" aria-hidden="true" />
          {t('homeDashboard.logout')}
        </Button>
      </div>

      {/* Hero row: checkout + the rest of the point-of-sale group */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {posItem && PosIcon && (
          <Button
            type="button"
            variant="default"
            onClick={() => {
              handleItemClick(posItem);
            }}
            aria-label={t(posItem.labelKey)}
            className="group/hero relative col-span-2 flex h-auto min-h-[9.5rem] w-full items-stretch justify-between overflow-hidden rounded-3xl bg-primary p-6 text-left text-primary-foreground shadow-lg animate-fade-up transition-[transform,box-shadow] duration-200 ease-out-quart hover:-translate-y-0.5 hover:bg-primary hover:shadow-xl md:col-span-3 lg:col-span-3 lg:p-8"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_100%_0%,var(--brand)_0%,transparent_55%)] opacity-40 transition-opacity duration-300 group-hover/hero:opacity-60"
            />
            <div className="relative flex flex-col justify-between gap-6">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary-foreground/10 text-primary-foreground ring-1 ring-primary-foreground/15">
                <PosIcon className="size-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <span className="block text-2xl font-semibold tracking-tight lg:text-3xl">
                  {t(posItem.labelKey)}
                </span>
                <span className="block text-sm text-primary-foreground/70">
                  {t('homeDashboard.posHint')}
                </span>
              </div>
            </div>
            <ArrowRight
              className="relative size-8 shrink-0 self-end text-primary-foreground/70 transition-transform duration-200 group-hover/hero:translate-x-1"
              aria-hidden="true"
            />
          </Button>
        )}
        {NAV_ITEMS.filter(item => item.group === 'sell' && item.path !== '/pos').map(
          (item, index) => renderTile(item, index)
        )}
      </div>

      {/* Sections */}
      {NAV_GROUPS.filter(group => group.key !== 'sell').map(group => {
        const items = NAV_ITEMS.filter(item => item.group === group.key);
        if (items.length === 0) return null;
        return (
          <section key={group.key} className="space-y-3">
            <h2 className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              {t(`homeDashboard.sections.${group.key}`)}
            </h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {items.map((item, index) => renderTile(item, index))}
            </div>
          </section>
        );
      })}

      {/* Manager PIN gate dialog */}
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
          void navigate(path);
        }}
      />
    </div>
  );
}
