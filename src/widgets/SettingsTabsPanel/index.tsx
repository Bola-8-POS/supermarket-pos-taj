import {
  CalendarClock,
  DatabaseBackup,
  KeyRound,
  Languages,
  Lock,
  Mail,
  Printer,
  Receipt,
  Store,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStaffStore } from '@entities/staff/model/store';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { useNavigationGuardStore } from '@shared/lib/navigation-guard';
import { Tabs, TabsContent } from '@shared/ui/tabs';
import { VerticalTabsGroupLabel, VerticalTabsList, VerticalTabsTrigger } from '@shared/ui/vertical-tabs';
import { UnsavedChangesContext, useUnsavedChangesController } from './model/unsaved-changes';
import { useCloseGuard } from './model/useCloseGuard';
import { BackupSettingsTab } from './tabs/BackupSettingsTab';
import { BillingSettingsTab } from './tabs/BillingSettingsTab';
import { EmailReceiptsSettingsTab } from './tabs/EmailReceiptsSettingsTab';
import { GeneralSettingsTab } from './tabs/GeneralSettingsTab';
import { HardwareSettingsTab } from './tabs/HardwareSettingsTab';
import { LanguageSettingsTab } from './tabs/LanguageSettingsTab';
import { LicenseSettingsTab } from './tabs/LicenseSettingsTab';
import { LockSettingsTab } from './tabs/LockSettingsTab';
import { NearExpirySettingsTab } from './tabs/NearExpirySettingsTab';
import { UnsavedChangesDialog } from './ui/UnsavedChangesDialog';

type TabItem = {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  render: () => ReactNode;
};

type TabGroup = {
  key: 'personal' | 'store' | 'receipts' | 'stock' | 'security';
  tabs: TabItem[];
};

export function SettingsTabsPanel() {
  const { t } = useTranslation('settings');
  const currentRole = useStaffStore(s => s.currentStaff?.role ?? null);
  const { can } = usePermissions();
  const canManageSettings = can('manage_settings');
  const canManageProducts = can('manage_products');

  const groups = useMemo<TabGroup[]>(() => {
    // Role-agnostic — always present so every authenticated role (incl.
    // cashier) has a non-empty list and Language is the default tab.
    const personal: TabItem[] = [
      {
        key: 'language',
        label: t('tabs.language'),
        description: t('descriptions.language'),
        icon: Languages,
        render: () => <LanguageSettingsTab />,
      },
    ];
    const store: TabItem[] = [];
    const receipts: TabItem[] = [];
    const stock: TabItem[] = [];
    const security: TabItem[] = [];

    if (canManageSettings) {
      store.push({
        key: 'general',
        label: t('tabs.general'),
        description: t('descriptions.general'),
        icon: Store,
        render: () => <GeneralSettingsTab currentRole={currentRole} />,
      });
      receipts.push(
        {
          key: 'hardware',
          label: t('tabs.hardware'),
          description: t('descriptions.hardware'),
          icon: Printer,
          render: () => <HardwareSettingsTab currentRole={currentRole} />,
        },
        {
          key: 'email',
          label: t('tabs.email'),
          description: t('descriptions.email'),
          icon: Mail,
          render: () => <EmailReceiptsSettingsTab currentRole={currentRole} />,
        }
      );
      stock.push({
        key: 'near-expiry',
        label: t('tabs.nearExpiry'),
        description: t('descriptions.nearExpiry'),
        icon: CalendarClock,
        render: () => <NearExpirySettingsTab currentRole={currentRole} />,
      });
      security.push(
        {
          key: 'lock-timeout',
          label: t('tabs.lockTimeout'),
          description: t('descriptions.lockTimeout'),
          icon: Lock,
          render: () => <LockSettingsTab currentRole={currentRole} />,
        },
        {
          key: 'backup',
          label: t('tabs.backup'),
          description: t('descriptions.backup'),
          icon: DatabaseBackup,
          render: () => <BackupSettingsTab currentRole={currentRole} />,
        },
        {
          key: 'license',
          label: t('tabs.license'),
          description: t('descriptions.license'),
          icon: KeyRound,
          render: () => <LicenseSettingsTab />,
        }
      );
    }
    // Billing keeps its historical manage_products gate (unchanged behaviour).
    if (canManageProducts) {
      store.push({
        key: 'billing',
        label: t('tabs.billing'),
        description: t('descriptions.billing'),
        icon: Receipt,
        render: () => <BillingSettingsTab currentRole={currentRole} />,
      });
    }

    const all: TabGroup[] = [
      { key: 'personal', tabs: personal },
      { key: 'store', tabs: store },
      { key: 'receipts', tabs: receipts },
      { key: 'stock', tabs: stock },
      { key: 'security', tabs: security },
    ];
    return all.filter(group => group.tabs.length > 0);
  }, [canManageProducts, canManageSettings, currentRole, t]);

  const allTabs = groups.flatMap(group => group.tabs);
  const initialKey = allTabs[0]?.key ?? '';

  // All hooks must run unconditionally above the `!firstTab` early return
  // below (hook-order rule) — allTabs[0]?.key is used instead of the
  // non-null firstTab so this useState call never depends on that branch.
  const controller = useUnsavedChangesController();
  const [activeTab, setActiveTab] = useState(initialKey);

  // Installs the panel's unsaved-changes prompt as the app-wide navigation
  // guard (see @shared/lib/navigation-guard) while Settings is mounted —
  // e.g. clicking a Sidebar link away from a dirty tab now also prompts.
  // `controller.requestLeave` is referentially stable (useCallback over
  // refs), so this effect installs/uninstalls the guard exactly once.
  useEffect(() => {
    useNavigationGuardStore.getState().setGuard(() => controller.requestLeave());
    return () => {
      useNavigationGuardStore.getState().setGuard(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only requestLeave's identity matters; controller itself is a fresh object every render
  }, [controller.requestLeave]);

  // Guards the app window's own close button/Alt+F4 the same way — a dirty
  // tab shouldn't be silently discarded just because the user closed the
  // window instead of navigating away inside it.
  useCloseGuard(controller.isDirty, controller.requestLeave);

  const handleTabChange = (next: string) => {
    if (next === activeTab) return;
    void controller.requestLeave().then(ok => {
      if (ok) setActiveTab(next);
    });
  };

  const firstTab = allTabs[0];
  if (!firstTab) {
    return (
      <section className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-xs">
        {t('noPermission')}
      </section>
    );
  }

  return (
    <UnsavedChangesContext.Provider value={controller.registry}>
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        orientation="vertical"
        className="grid w-full gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]"
      >
        <VerticalTabsList aria-label={t('navLabel')} className="self-start lg:sticky lg:top-0">
          {groups.map(group => (
            <Fragment key={group.key}>
              <VerticalTabsGroupLabel>{t(`groups.${group.key}`)}</VerticalTabsGroupLabel>
              {group.tabs.map(tab => (
                <VerticalTabsTrigger
                  key={tab.key}
                  value={tab.key}
                  icon={tab.icon}
                  label={tab.label}
                  description={tab.description}
                />
              ))}
            </Fragment>
          ))}
        </VerticalTabsList>
        <div className="min-w-0">
          {allTabs.map(tab => (
            <TabsContent
              key={tab.key}
              value={tab.key}
              className="min-h-[24rem] rounded-2xl border border-border bg-card p-6 shadow-xs"
            >
              {tab.render()}
            </TabsContent>
          ))}
        </div>
      </Tabs>
      <UnsavedChangesDialog {...controller.dialogProps} />
    </UnsavedChangesContext.Provider>
  );
}
