import {
  BarChart3,
  CalendarCheck,
  Clock,
  CreditCard,
  History,
  Layers,
  Package,
  ReceiptText,
  Trash2,
  Undo2,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CajaReportPanel } from '@widgets/CajaReportPanel';
import { CategoryRevenuePanel } from '@widgets/CategoryRevenuePanel';
import { DeletionsPostCloseReport } from '@widgets/DeletionsPostCloseReport';
import { DeletionsPreSendPanel } from '@widgets/DeletionsPreSendPanel';
import { HourlyBreakdownPanel } from '@widgets/HourlyBreakdownPanel';
import { InventoryAnalyticsPanel } from '@widgets/InventoryAnalyticsPanel';
import { PaymentMethodsReport } from '@widgets/PaymentMethodsReport';
import { ProductSalesPanel } from '@widgets/ProductSalesPanel';
import { RefundsRegister } from '@widgets/RefundsRegister';
import { StaffSalesPanel } from '@widgets/StaffSalesPanel';
import { VoidRefundPanel } from '@widgets/VoidRefundPanel';
import { DateRangePicker, PageContainer } from '@shared/ui';
import { Tabs, TabsContent } from '@shared/ui/tabs';
import { VerticalTabsGroupLabel, VerticalTabsList, VerticalTabsTrigger } from '@shared/ui/vertical-tabs';

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
}

function fromDateStr(s: string, endOfDay: boolean): Date {
  const [y, m, day] = s.split('-').map(Number);
  const d = new Date(y ?? 0, (m ?? 1) - 1, day ?? 1);
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d;
}

type ReportKey =
  | 'session'
  | 'products'
  | 'hourly'
  | 'categories'
  | 'payment-methods'
  | 'inventory-analytics'
  | 'staff'
  | 'voids'
  | 'deletions-pre'
  | 'deletions-post'
  | 'refunds-reg';

type ReportDef = {
  key: ReportKey;
  group: 'sales' | 'inventoryAnalytics' | 'staffTips' | 'operations';
  labelKey: string;
  descKey: string;
  icon: LucideIcon;
  usesDateRange: boolean;
  render: (range: { from: Date; to: Date }) => ReactNode;
};

/* eslint-disable i18next/no-literal-string -- i18n key lookup table, not UI copy */
const REPORTS: ReportDef[] = [
  {
    key: 'session',
    group: 'sales',
    labelKey: 'reports.tabs.session',
    descKey: 'reports.descriptions.session',
    icon: CalendarCheck,
    usesDateRange: false,
    render: () => <CajaReportPanel />,
  },
  {
    key: 'products',
    group: 'sales',
    labelKey: 'reports.tabs.products',
    descKey: 'reports.descriptions.products',
    icon: Package,
    usesDateRange: true,
    render: r => <ProductSalesPanel dateRange={r} />,
  },
  {
    key: 'hourly',
    group: 'sales',
    labelKey: 'reports.tabs.hourly',
    descKey: 'reports.descriptions.hourly',
    icon: Clock,
    usesDateRange: true,
    render: r => <HourlyBreakdownPanel dateRange={r} />,
  },
  {
    key: 'categories',
    group: 'sales',
    labelKey: 'reports.tabs.categories',
    descKey: 'reports.descriptions.categories',
    icon: Layers,
    usesDateRange: true,
    render: r => <CategoryRevenuePanel dateRange={r} />,
  },
  {
    key: 'payment-methods',
    group: 'sales',
    labelKey: 'reports.tabs.paymentMethods',
    descKey: 'reports.descriptions.paymentMethods',
    icon: CreditCard,
    usesDateRange: true,
    render: r => <PaymentMethodsReport dateRange={r} />,
  },
  {
    key: 'inventory-analytics',
    group: 'inventoryAnalytics',
    labelKey: 'reports.tabs.inventoryAnalytics',
    descKey: 'reports.descriptions.inventoryAnalytics',
    icon: BarChart3,
    usesDateRange: true,
    render: r => <InventoryAnalyticsPanel dateRange={r} />,
  },
  {
    key: 'staff',
    group: 'staffTips',
    labelKey: 'reports.tabs.staff',
    descKey: 'reports.descriptions.staff',
    icon: Users,
    usesDateRange: true,
    render: r => <StaffSalesPanel dateRange={r} />,
  },
  {
    key: 'voids',
    group: 'operations',
    labelKey: 'reports.tabs.voids',
    descKey: 'reports.descriptions.voids',
    icon: Undo2,
    usesDateRange: true,
    render: r => <VoidRefundPanel dateRange={r} />,
  },
  {
    key: 'deletions-pre',
    group: 'operations',
    labelKey: 'reports.tabs.deletionsPre',
    descKey: 'reports.descriptions.deletionsPre',
    icon: Trash2,
    usesDateRange: true,
    render: r => <DeletionsPreSendPanel dateRange={r} />,
  },
  {
    key: 'deletions-post',
    group: 'operations',
    labelKey: 'reports.tabs.deletionsPost',
    descKey: 'reports.descriptions.deletionsPost',
    icon: History,
    usesDateRange: true,
    render: r => <DeletionsPostCloseReport dateRange={r} />,
  },
  {
    key: 'refunds-reg',
    group: 'operations',
    labelKey: 'reports.tabs.refundsReg',
    descKey: 'reports.descriptions.refundsReg',
    icon: ReceiptText,
    usesDateRange: true,
    render: r => <RefundsRegister dateRange={r} />,
  },
];

const GROUP_ORDER = ['sales', 'inventoryAnalytics', 'staffTips', 'operations'] as const;
/* eslint-enable i18next/no-literal-string */

export default function ReportsPage() {
  const { t } = useTranslation('pages');
  const today = toDateStr(new Date());
  const [fromStr, setFromStr] = useState(today);
  const [toStr, setToStr] = useState(today);
  const [active, setActive] = useState<ReportKey>('session');

  const dateRange = { from: fromDateStr(fromStr, false), to: fromDateStr(toStr, true) };

  function handleDateChange(f: string, tStr: string) {
    setFromStr(f);
    setToStr(tStr);
  }

  return (
    <PageContainer title={t('reports.title')} width="fluid">
      <Tabs
        value={active}
        onValueChange={next => {
          setActive(next as ReportKey);
        }}
        orientation="vertical"
        className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]"
      >
        <VerticalTabsList aria-label={t('reports.navLabel')} className="self-start lg:sticky lg:top-0">
          {GROUP_ORDER.map(group => (
            <Fragment key={group}>
              <VerticalTabsGroupLabel>{t(`reports.groups.${group}`)}</VerticalTabsGroupLabel>
              {REPORTS.filter(r => r.group === group).map(r => (
                <VerticalTabsTrigger
                  key={r.key}
                  value={r.key}
                  icon={r.icon}
                  label={t(r.labelKey)}
                  description={t(r.descKey)}
                />
              ))}
            </Fragment>
          ))}
        </VerticalTabsList>

        <div className="min-w-0">
          {REPORTS.map(r => (
            <TabsContent key={r.key} value={r.key} className="space-y-4">
              <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
                <div className="min-w-0 space-y-1">
                  <h3 className="text-lg font-semibold tracking-tight">{t(r.labelKey)}</h3>
                  <p className="text-sm text-muted-foreground">{t(r.descKey)}</p>
                </div>
                {r.usesDateRange && (
                  <DateRangePicker fromStr={fromStr} toStr={toStr} onChange={handleDateChange} />
                )}
              </div>
              {r.render(dateRange)}
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </PageContainer>
  );
}
