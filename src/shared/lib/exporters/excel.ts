// SECURITY: xlsx package has unresolved CVEs (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9).
// Risk is LOW in this Tauri desktop context — no untrusted file input.
// Track replacement with exceljs in a future debt sprint.
// See: .planning/decisions/xlsx-cve-risk-accept.md
import * as XLSX from 'xlsx';
import type {
  CajaReport,
  CategoryRevenueRow,
  HourlyRow,
  ProductSalesRow,
  RefundRegisterRow,
  StaffMetric,
  VoidRefundRow,
} from '@shared/lib/domain';

const MONEY_FMT = '"$"#,##0.00';

function moneyCell(value: number): XLSX.CellObject {
  return { t: 'n', v: value, z: MONEY_FMT };
}

function cellAddr(col: string, rowIdx: number): string {
  return `${col}${String(rowIdx)}`;
}

export function cajaReportToWorkbook(report: CajaReport): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const summaryData = [
    ['Metric', 'Value'],
    ['Total Revenue', report.summary.totalRevenue],
    ['Cash Sales', report.summary.cashSales],
    ['Card Sales', report.summary.cardSales],
    ['Rappi Sales', report.summary.rappiSales],
    ['Uber Eats Sales', report.summary.uberEatsSales],
    ['Bank Transfer Sales', report.summary.bankTransferSales],
    ['Bank Transfer Pending', report.summary.bankTransferPending],
    ['Order Count', report.summary.orderCount],
    ['Tab Count', report.summary.tabCount],
    ['Total Expenses', report.summary.totalExpenses],
    ['Total Income', report.summary.totalIncome],
    ['Net Balance', report.summary.netBalance],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  wsSummary['B2'] = moneyCell(report.summary.totalRevenue);
  wsSummary['B3'] = moneyCell(report.summary.cashSales);
  wsSummary['B4'] = moneyCell(report.summary.cardSales);
  wsSummary['B5'] = moneyCell(report.summary.rappiSales);
  wsSummary['B6'] = moneyCell(report.summary.uberEatsSales);
  wsSummary['B7'] = moneyCell(report.summary.bankTransferSales);
  wsSummary['B8'] = moneyCell(report.summary.bankTransferPending);
  wsSummary['B11'] = moneyCell(report.summary.totalExpenses);
  wsSummary['B12'] = moneyCell(report.summary.totalIncome);
  wsSummary['B13'] = moneyCell(report.summary.netBalance);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  const productRows = [
    ['Product Name', 'Quantity', 'Revenue'],
    ...report.topProducts.map(p => [p.productName, p.quantity, p.revenue]),
  ];
  const wsProducts = XLSX.utils.aoa_to_sheet(productRows);
  report.topProducts.forEach((_, i) => {
    wsProducts[cellAddr('C', i + 2)] = moneyCell(report.topProducts[i]?.revenue ?? 0);
  });
  XLSX.utils.book_append_sheet(wb, wsProducts, 'Top Products');

  const staffRows = [
    ['Staff Name', 'Order Count', 'Sales Total'],
    ...report.staffSummary.map(s => [s.staffName, s.orderCount, s.salesTotal]),
  ];
  const wsStaff = XLSX.utils.aoa_to_sheet(staffRows);
  report.staffSummary.forEach((s, i) => {
    wsStaff[cellAddr('C', i + 2)] = moneyCell(s.salesTotal);
  });
  XLSX.utils.book_append_sheet(wb, wsStaff, 'Staff');

  const rec = report.cashReconciliation;
  const reconData = [
    ['Item', 'Amount'],
    ['Opening Cash', rec.openingCash],
    ['Cash Sales', rec.cashSales],
    ['Expected Cash', rec.expectedCash],
    ['Closing Cash', rec.closingCash ?? '—'],
    ['Variance', rec.variance ?? '—'],
  ];
  const wsRecon = XLSX.utils.aoa_to_sheet(reconData);
  wsRecon['B2'] = moneyCell(rec.openingCash);
  wsRecon['B3'] = moneyCell(rec.cashSales);
  wsRecon['B4'] = moneyCell(rec.expectedCash);
  if (rec.closingCash !== null) wsRecon['B5'] = moneyCell(rec.closingCash);
  if (rec.variance !== null) wsRecon['B6'] = moneyCell(rec.variance);
  XLSX.utils.book_append_sheet(wb, wsRecon, 'Cash Reconciliation');

  return wb;
}

export function productSalesToWorkbook(
  rows: ProductSalesRow[],
  dateRange: { from: Date; to: Date }
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const header = [
    [
      `Product Sales Report: ${dateRange.from.toLocaleDateString()} – ${dateRange.to.toLocaleDateString()}`,
    ],
    [],
    ['Product Name', 'Category', 'Units Sold', 'Revenue', '% of Total', 'Margin'],
    ...rows.map(r => [r.productName, r.categoryName, r.units, r.revenue, r.pctTotal, r.margin]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(header);
  rows.forEach((r, i) => {
    ws[cellAddr('D', i + 4)] = moneyCell(r.revenue);
    if (r.margin !== null) ws[cellAddr('F', i + 4)] = moneyCell(r.margin);
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Product Sales');

  return wb;
}

export function hourlySalesToWorkbook(rows: HourlyRow[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // D-04: day-of-week + busiest-hour indicator carried into the export, not just on screen.
  const header = [
    ['Hour', 'Day of Week', 'Orders', 'Revenue', 'Busiest'],
    ...rows.map(r => [r.hour, r.dayOfWeek, r.orderCount, r.revenue, r.isBusiest ? 'Yes' : '']),
  ];
  const ws = XLSX.utils.aoa_to_sheet(header);
  rows.forEach((r, i) => {
    ws[cellAddr('D', i + 2)] = moneyCell(r.revenue);
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Hourly Sales');

  return wb;
}

export function voidRefundToWorkbook(
  rows: VoidRefundRow[],
  dateRange: { from: Date; to: Date }
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const header = [
    [
      `Voids & Refunds: ${dateRange.from.toLocaleDateString()} – ${dateRange.to.toLocaleDateString()}`,
    ],
    [],
    ['Timestamp', 'Staff', 'Amount', 'Reason'],
    ...rows.map(r => [r.voidedAt.toLocaleString(), r.staffName, r.amount, r.reason]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(header);
  rows.forEach((r, i) => {
    ws[cellAddr('C', i + 4)] = moneyCell(r.amount);
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Voids & Refunds');

  return wb;
}

export function categoryRevenueToWorkbook(
  rows: CategoryRevenueRow[],
  dateRange: { from: Date; to: Date }
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const header = [
    [
      `Revenue by Category: ${dateRange.from.toLocaleDateString()} – ${dateRange.to.toLocaleDateString()}`,
    ],
    [],
    ['Category', 'Units Sold', 'Orders', 'Revenue', '% of Total'],
    ...rows.map(r => [r.categoryName, r.unitsSold, r.orderCount, r.revenue, r.pctTotal]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(header);
  rows.forEach((_r, i) => {
    ws[cellAddr('D', i + 4)] = moneyCell(rows[i]?.revenue ?? 0);
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Revenue by Category');

  return wb;
}

export function staffMetricsToWorkbook(
  rows: StaffMetric[],
  dateRange: { from: Date; to: Date }
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const header = [
    [
      `Staff Performance Report: ${dateRange.from.toLocaleDateString()} – ${dateRange.to.toLocaleDateString()}`,
    ],
    [],
    ['Staff Member', 'Revenue', 'Transactions', 'Avg Check', 'Voids'],
    ...rows.map(r => [r.staffName, r.revenue, r.transactionCount, r.avgCheckSize, r.voidCount]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(header);
  rows.forEach((_r, i) => {
    ws[cellAddr('B', i + 4)] = moneyCell(rows[i]?.revenue ?? 0);
    ws[cellAddr('D', i + 4)] = moneyCell(rows[i]?.avgCheckSize ?? 0);
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Staff Performance');

  return wb;
}

export function workbookToBytes(wb: XLSX.WorkBook): Uint8Array {
  const buf: ArrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(buf);
}

// Phase 8 S6-08 workbook builders

export function refundsRegisterToWorkbook(
  rows: RefundRegisterRow[],
  dateRange: { from: Date; to: Date }
): XLSX.WorkBook {
  const title = `Refunds Register ${dateRange.from.toLocaleDateString('es-MX')} – ${dateRange.to.toLocaleDateString('es-MX')}`;
  const header = ['Date', 'Operator', 'Payment ID', 'Amount', 'Reason', 'Restock Count'];
  const data = [
    [title],
    [],
    header,
    ...rows.map(r => [
      new Date(r.date).toLocaleDateString('es-MX'),
      r.operatorName,
      r.originalPaymentId,
      moneyCell(r.amount),
      r.reason,
      r.restockCount,
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Refunds Register');
  return wb;
}
