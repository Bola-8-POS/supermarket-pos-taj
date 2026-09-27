import { Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  ShrinkageRow,
  TurnoverRow,
  ValuationRow,
} from '@entities/inventory/model/queries-analytics';
import { useStaffStore } from '@entities/staff/model/store';
import type {
  CajaReport,
  CategoryRevenueRow,
  DeletionsPostRow,
  DeletionsPreRow,
  HourlyRow,
  PaymentMethodRow,
  ProductSalesRow,
  RefundRegisterRow,
  StaffMetric,
  VoidRefundRow,
} from '@shared/lib/domain';
import { useFeature } from '@shared/lib/license/features';
import { canAccess } from '@shared/lib/rbac';
import { LockedFeature } from '@shared/ui/LockedFeature';
import { POSButton } from '@shared/ui/POSButton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useExportReport } from '../model/useExportReport';

type CajaProps = {
  reportType: 'caja';
  data: CajaReport;
};

type ProductsProps = {
  reportType: 'products';
  data: { rows: ProductSalesRow[]; dateRange: { from: Date; to: Date } };
};

type HourlyProps = {
  reportType: 'hourly';
  data: HourlyRow[];
};

type VoidsProps = {
  reportType: 'voids';
  data: { rows: VoidRefundRow[]; dateRange: { from: Date; to: Date } };
};

type CategoriesProps = {
  reportType: 'categories';
  data: { rows: CategoryRevenueRow[]; dateRange: { from: Date; to: Date } };
};

type StaffProps = {
  reportType: 'staff';
  data: { rows: StaffMetric[]; dateRange: { from: Date; to: Date } };
};

type RefundsRegisterProps = {
  reportType: 'refunds-register';
  data: { rows: RefundRegisterRow[]; dateRange: { from: Date; to: Date } };
};

type DeletionsPreProps = {
  reportType: 'deletions-pre';
  data: { rows: DeletionsPreRow[]; dateRange: { from: Date; to: Date } };
};

type DeletionsPostProps = {
  reportType: 'deletions-post';
  data: { rows: DeletionsPostRow[]; dateRange: { from: Date; to: Date } };
};

type PaymentMethodsProps = {
  reportType: 'payment-methods';
  data: { rows: PaymentMethodRow[]; dateRange: { from: Date; to: Date } };
};

type ValuationProps = {
  reportType: 'valuation';
  data: { rows: ValuationRow[]; dateRange: { from: Date; to: Date } };
};

type ShrinkageWasteProps = {
  reportType: 'shrinkage-waste';
  data: { rows: ShrinkageRow[]; dateRange: { from: Date; to: Date } };
};

type ExpiryLossProps = {
  reportType: 'expiry-loss';
  data: { rows: ShrinkageRow[]; dateRange: { from: Date; to: Date } };
};

type TurnoverProps = {
  reportType: 'turnover';
  data: { rows: TurnoverRow[]; dateRange: { from: Date; to: Date } };
};

type Props =
  | CajaProps
  | ProductsProps
  | HourlyProps
  | VoidsProps
  | CategoriesProps
  | StaffProps
  | RefundsRegisterProps
  | DeletionsPreProps
  | DeletionsPostProps
  | PaymentMethodsProps
  | ValuationProps
  | ShrinkageWasteProps
  | ExpiryLossProps
  | TurnoverProps;

export function ExportButtons(props: Props) {
  const { t } = useTranslation('featMgmt');
  const role = useStaffStore(s => s.currentStaff?.role);
  const { exportReport, isExporting } = useExportReport();
  const { locked } = useFeature('report_export');

  if (!canAccess(role, 'view_reports')) {
    return null;
  }

  /* eslint-disable i18next/no-literal-string -- ExportType literal-union branches
     (e.g. 'caja-excel'), not UI copy */
  function handleExport(format: 'excel' | 'pdf' | 'csv') {
    void (async () => {
      if (props.reportType === 'caja') {
        const type = format === 'excel' ? 'caja-excel' : format === 'pdf' ? 'caja-pdf' : 'caja-csv';
        await exportReport(type, props.data);
      } else if (props.reportType === 'products') {
        const type =
          format === 'excel'
            ? 'products-excel'
            : format === 'pdf'
              ? 'products-pdf'
              : 'products-csv';
        await exportReport(type, props.data);
      } else if (props.reportType === 'hourly') {
        const type =
          format === 'excel' ? 'hourly-excel' : format === 'pdf' ? 'hourly-pdf' : 'hourly-csv';
        await exportReport(type, props.data);
      } else if (props.reportType === 'voids') {
        const type =
          format === 'excel' ? 'voids-excel' : format === 'pdf' ? 'voids-pdf' : 'voids-csv';
        await exportReport(type, props.data);
      } else if (props.reportType === 'staff') {
        const type =
          format === 'excel' ? 'staff-excel' : format === 'pdf' ? 'staff-pdf' : 'staff-csv';
        await exportReport(type, props.data);
      } else if (props.reportType === 'refunds-register') {
        const type =
          format === 'excel'
            ? 'refunds-register-excel'
            : format === 'pdf'
              ? 'refunds-register-pdf'
              : 'refunds-register-csv';
        await exportReport(type, props.data);
      } else if (props.reportType === 'deletions-pre') {
        await exportReport('deletions-pre-csv', props.data);
      } else if (props.reportType === 'deletions-post') {
        await exportReport('deletions-post-csv', props.data);
      } else if (props.reportType === 'payment-methods') {
        await exportReport('payment-methods-csv', props.data);
      } else if (props.reportType === 'valuation') {
        await exportReport('valuation-csv', props.data);
      } else if (props.reportType === 'shrinkage-waste') {
        await exportReport('shrinkage-waste-csv', props.data);
      } else if (props.reportType === 'expiry-loss') {
        await exportReport('expiry-loss-csv', props.data);
      } else if (props.reportType === 'turnover') {
        await exportReport('turnover-csv', props.data);
      } else {
        const type =
          format === 'excel'
            ? 'categories-excel'
            : format === 'pdf'
              ? 'categories-pdf'
              : 'categories-csv';
        await exportReport(type, props.data);
      }
    })();
  }
  /* eslint-enable i18next/no-literal-string */

  // The 5 net-new report types are CSV-only for now (no Excel/PDF ExportType
  // literal exists for them yet, D-11/D-12) — showing Excel/PDF buttons that
  // silently produce a CSV would be a misleading toolbar.
  /* eslint-disable i18next/no-literal-string -- reportType literal comparisons, not UI copy */
  const isCsvOnly =
    props.reportType === 'deletions-pre' ||
    props.reportType === 'deletions-post' ||
    props.reportType === 'payment-methods' ||
    props.reportType === 'valuation' ||
    props.reportType === 'shrinkage-waste' ||
    props.reportType === 'expiry-loss' ||
    props.reportType === 'turnover';
  /* eslint-enable i18next/no-literal-string */

  if (locked) {
    return (
      <LockedFeature feature="report_export">
        <POSButton variant="outline" touchSize="default">
          <Download className="mr-2 size-4" />
          {t('exportReport.exportButton')}
        </POSButton>
      </LockedFeature>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <POSButton variant="outline" touchSize="default" disabled={isExporting}>
          {isExporting ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Download className="mr-2 size-4" />
          )}
          {t('exportReport.exportButton')}
        </POSButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel inset={undefined}>{t('exportReport.downloadAs')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!isCsvOnly && (
          <>
            <DropdownMenuItem
              inset={undefined}
              variant={undefined}
              onSelect={() => {
                handleExport('excel');
              }}
            >
              {t('exportReport.excelOption')}
            </DropdownMenuItem>
            <DropdownMenuItem
              inset={undefined}
              variant={undefined}
              onSelect={() => {
                handleExport('pdf');
              }}
            >
              {t('exportReport.pdfOption')}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem
          inset={undefined}
          variant={undefined}
          onSelect={() => {
            handleExport('csv');
          }}
        >
          {t('exportReport.csvOption')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
