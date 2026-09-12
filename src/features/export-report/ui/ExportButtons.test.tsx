/**
 * Unit tests for ExportButtons (src/features/export-report/ui/ExportButtons.tsx)
 *
 * Asserts a CSV dropdown item renders for every reportType (D-11/D-12: every
 * report tab expose CSV via one generic serializer + the same dropdown).
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { renderWithProviders } from '@shared/lib/test-utils';
import { ExportButtons } from './ExportButtons';

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: vi.fn(),
}));

const DATE_RANGE = { from: new Date('2026-01-01'), to: new Date('2026-01-31') };

const CAJA_REPORT: CajaReport = {
  cajaSession: {
    id: '00000000-0000-0000-0000-000000000001',
    openedAt: new Date('2026-01-01T08:00:00Z'),
    closedAt: null,
    openedBy: '00000000-0000-0000-0000-000000000002',
    closedBy: null,
    openingCash: 500,
    closingCash: null,
    notes: null,
    status: 'open',
  },
  summary: {
    totalRevenue: 1000,
    cashSales: 600,
    cardSales: 400,
    rappiSales: 0,
    uberEatsSales: 0,
    bankTransferSales: 0,
    bankTransferPending: 0,
    orderCount: 10,
    tabCount: 5,
    totalExpenses: 0,
    totalIncome: 0,
    netBalance: 1000,
  },
  cashReconciliation: {
    openingCash: 500,
    cashSales: 600,
    expectedCash: 1100,
    closingCash: null,
    variance: null,
  },
  topProducts: [],
  staffSummary: [],
  cajaEntries: [],
};

const PRODUCT_ROWS: ProductSalesRow[] = [
  {
    productId: 'p1',
    productName: 'Corona',
    categoryName: 'Beer',
    units: 5,
    revenue: 100,
    costTotal: 60,
    margin: 40,
    marginPct: 40,
    pctTotal: 1,
  },
];

const HOURLY_ROWS: HourlyRow[] = [
  { hour: 20, orderCount: 5, revenue: 200, dayOfWeek: 5, isBusiest: true },
];

const VOID_ROWS: VoidRefundRow[] = [
  {
    orderId: '11111111-1111-1111-1111-111111111111',
    voidedAt: new Date('2026-01-05T10:00:00Z'),
    staffName: 'Alex',
    amount: 20,
    reason: 'wrong item',
  },
];

const CATEGORY_ROWS: CategoryRevenueRow[] = [
  {
    categoryId: 'c1',
    categoryName: 'Beer',
    unitsSold: 10,
    orderCount: 5,
    revenue: 200,
    pctTotal: 1,
  },
];

const STAFF_ROWS: StaffMetric[] = [
  {
    staffId: '22222222-2222-2222-2222-222222222222',
    staffName: 'Alex',
    revenue: 100,
    transactionCount: 5,
    avgCheckSize: 20,
    voidCount: 0,
  },
];

const REFUNDS_REGISTER_ROWS: RefundRegisterRow[] = [
  {
    id: '66666666-6666-6666-6666-666666666666',
    date: new Date('2026-01-05T10:00:00Z'),
    operatorName: 'Alex',
    originalPaymentId: '77777777-7777-7777-7777-777777777777',
    amount: 20,
    reason: 'customer_complaint',
    restockCount: 1,
    items: [],
  },
];

const DELETIONS_PRE_ROWS: DeletionsPreRow[] = [
  {
    orderId: '99999999-9999-9999-9999-999999999999',
    itemName: 'Beer',
    removedAt: new Date('2026-01-05T10:00:00Z'),
    staffName: 'Alex',
    reason: 'wrong item',
  },
];

const DELETIONS_POST_ROWS: DeletionsPostRow[] = [
  {
    tabId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    editedAt: new Date('2026-01-05T10:00:00Z'),
    staffName: 'Alex',
    reason: 'correction',
    fieldsChanged: ['amount'],
  },
];

const PAYMENT_METHOD_ROWS: PaymentMethodRow[] = [
  {
    cajaSessionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    method: 'cash',
    legCount: 5,
    grossAmount: 100,
    isRollup: false,
  },
];

const CASES: { reportType: string; data: unknown; excelPdf: boolean }[] = [
  { reportType: 'caja', data: CAJA_REPORT, excelPdf: true },
  { reportType: 'products', data: { rows: PRODUCT_ROWS, dateRange: DATE_RANGE }, excelPdf: true },
  { reportType: 'hourly', data: HOURLY_ROWS, excelPdf: true },
  { reportType: 'voids', data: { rows: VOID_ROWS, dateRange: DATE_RANGE }, excelPdf: true },
  {
    reportType: 'categories',
    data: { rows: CATEGORY_ROWS, dateRange: DATE_RANGE },
    excelPdf: true,
  },
  { reportType: 'staff', data: { rows: STAFF_ROWS, dateRange: DATE_RANGE }, excelPdf: true },
  {
    reportType: 'refunds-register',
    data: { rows: REFUNDS_REGISTER_ROWS, dateRange: DATE_RANGE },
    excelPdf: true,
  },
  {
    reportType: 'deletions-pre',
    data: { rows: DELETIONS_PRE_ROWS, dateRange: DATE_RANGE },
    excelPdf: false,
  },
  {
    reportType: 'deletions-post',
    data: { rows: DELETIONS_POST_ROWS, dateRange: DATE_RANGE },
    excelPdf: false,
  },
  {
    reportType: 'payment-methods',
    data: { rows: PAYMENT_METHOD_ROWS, dateRange: DATE_RANGE },
    excelPdf: false,
  },
];

describe('ExportButtons', () => {
  beforeEach(() => {
    vi.mocked(useStaffStore).mockImplementation(selector =>
      selector({
        currentStaff: { role: 'manager' },
      } as never)
    );
  });

  it.each(CASES)(
    'renders a CSV dropdown item for reportType=$reportType',
    async ({ data, excelPdf, ...rest }) => {
      // reportType is a discriminated union — cast through unknown since this
      // table intentionally covers all 17 literal variants generically.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const props = { reportType: rest.reportType, data } as any;
      renderWithProviders(<ExportButtons {...props} />);

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /export/i }));

      expect(await screen.findByRole('menuitem', { name: 'CSV' })).toBeInTheDocument();
      if (excelPdf) {
        expect(screen.getByRole('menuitem', { name: /excel/i })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: /pdf/i })).toBeInTheDocument();
      } else {
        expect(screen.queryByRole('menuitem', { name: /excel/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: /pdf/i })).not.toBeInTheDocument();
      }
    }
  );
});
