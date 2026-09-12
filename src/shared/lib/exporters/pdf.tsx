/* eslint-disable @typescript-eslint/no-unsafe-argument, react-refresh/only-export-components */
import { Document, Page, View, Text, StyleSheet, pdf } from '@react-pdf/renderer';
import React from 'react';
import type {
  CajaReport,
  CategoryRevenueRow,
  HourlyRow,
  Locale,
  ProductSalesRow,
  RefundRegisterRow,
  StaffMetric,
  VoidRefundRow,
} from '@shared/lib/domain';
import { formatMoneyIn } from '@shared/lib/format';
import { groupByCategory } from '@shared/lib/groupOrderItemsForReceipt';
import i18n, { getCurrentLocale } from '@shared/lib/i18n';

const DARK_HEADER = '#1e293b';

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: 'Helvetica', color: '#0f172a' },
  header: { marginBottom: 16 },
  title: { fontSize: 16, fontWeight: 'bold', marginBottom: 2 },
  subtitle: { fontSize: 10, color: '#64748b' },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: DARK_HEADER,
    color: '#ffffff',
    paddingHorizontal: 6,
    paddingVertical: 4,
    fontWeight: 'bold',
  },
  row: { flexDirection: 'row', paddingHorizontal: 6, paddingVertical: 3 },
  rowAlt: { backgroundColor: '#f8fafc' },
  cell: { flex: 1 },
  cellRight: { flex: 1, textAlign: 'right' },
  sectionTitle: { fontSize: 11, fontWeight: 'bold', marginTop: 14, marginBottom: 4 },
});

function fmt(locale: Locale, n: number): string {
  return formatMoneyIn(locale, n);
}

/** Resolves a locale-scoped translator for the `receipt` catalog namespace (Pattern 3 — pdf() renders outside the I18nextProvider tree, so useTranslation() cannot be used here). */
function pdfT(locale: Locale) {
  return i18n.getFixedT(locale, 'receipt');
}

function ReportHeader({ title, date, locale }: { title: string; date: string; locale: Locale }) {
  const tr = pdfT(locale);
  return (
    <View style={styles.header}>
      <Text style={styles.title}>{tr('pdf.appTitle')}</Text>
      <Text style={styles.subtitle}>{title}</Text>
      <Text style={styles.subtitle}>{date}</Text>
    </View>
  );
}

function CajaReportDoc({ report, locale }: { report: CajaReport; locale: Locale }) {
  const tr = pdfT(locale);
  const date = report.cajaSession.openedAt.toLocaleDateString(locale);
  const topProductGroups = groupByCategory(report.topProducts, locale);
  let topProductRowIndex = 0;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <ReportHeader title={tr('pdf.caja.title')} date={date} locale={locale} />

        <Text style={styles.sectionTitle}>{tr('pdf.caja.summary')}</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.caja.metric')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.caja.value')}</Text>
        </View>
        {[
          [tr('pdf.caja.totalRevenue'), fmt(locale, report.summary.totalRevenue)],
          [tr('pdf.caja.cashSales'), fmt(locale, report.summary.cashSales)],
          [tr('pdf.caja.cardSales'), fmt(locale, report.summary.cardSales)],
          [tr('pdf.caja.rappiSales'), fmt(locale, report.summary.rappiSales)],
          [tr('pdf.caja.uberEatsSales'), fmt(locale, report.summary.uberEatsSales)],
          [tr('pdf.caja.bankTransferSales'), fmt(locale, report.summary.bankTransferSales)],
          [tr('pdf.caja.bankTransferPending'), fmt(locale, report.summary.bankTransferPending)],
          [tr('pdf.caja.orderCount'), String(report.summary.orderCount)],
          [tr('pdf.caja.tabCount'), String(report.summary.tabCount)],
        ].map(([label, value], i) => (
          <View key={label} style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}>
            <Text style={styles.cell}>{label}</Text>
            <Text style={styles.cellRight}>{value}</Text>
          </View>
        ))}

        <Text style={styles.sectionTitle}>{tr('pdf.caja.cashReconciliation')}</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.caja.item')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.caja.amount')}</Text>
        </View>
        {[
          [tr('pdf.caja.openingCash'), fmt(locale, report.cashReconciliation.openingCash)],
          [tr('pdf.caja.cashSales'), fmt(locale, report.cashReconciliation.cashSales)],
          [tr('pdf.caja.expectedCash'), fmt(locale, report.cashReconciliation.expectedCash)],
          [
            tr('pdf.caja.closingCash'),
            report.cashReconciliation.closingCash !== null
              ? fmt(locale, report.cashReconciliation.closingCash)
              : '—',
          ],
          [
            tr('pdf.caja.variance'),
            report.cashReconciliation.variance !== null
              ? fmt(locale, report.cashReconciliation.variance)
              : '—',
          ],
        ].map(([label, value], i) => (
          <View key={label} style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}>
            <Text style={styles.cell}>{label}</Text>
            <Text style={styles.cellRight}>{value}</Text>
          </View>
        ))}

        <Text style={styles.sectionTitle}>{tr('pdf.caja.topProducts')}</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.caja.product')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.caja.qty')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.caja.revenue')}</Text>
        </View>
        {topProductGroups.map(group => (
          <React.Fragment key={group.categoryId ?? 'uncategorized'}>
            {topProductGroups.length > 1 && (
              <Text style={styles.sectionTitle}>
                {group.categoryName ?? tr('pdf.caja.categoryOther')}
              </Text>
            )}
            {group.items.map(p => {
              const i = topProductRowIndex++;
              return (
                <View key={p.productName} style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}>
                  <Text style={styles.cell}>{p.productName}</Text>
                  <Text style={styles.cellRight}>{String(p.quantity)}</Text>
                  <Text style={styles.cellRight}>{fmt(locale, p.revenue)}</Text>
                </View>
              );
            })}
          </React.Fragment>
        ))}

        <Text style={styles.sectionTitle}>{tr('pdf.caja.staffPerformance')}</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.caja.staff')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.caja.orders')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.caja.salesTotal')}</Text>
        </View>
        {report.staffSummary.map((s, i) => (
          <View key={s.staffId} style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}>
            <Text style={styles.cell}>{s.staffName}</Text>
            <Text style={styles.cellRight}>{String(s.orderCount)}</Text>
            <Text style={styles.cellRight}>{fmt(locale, s.salesTotal)}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

function ProductSalesDoc({
  rows,
  dateRange,
  locale,
}: {
  rows: ProductSalesRow[];
  dateRange: { from: Date; to: Date };
  locale: Locale;
}) {
  const tr = pdfT(locale);
  const dateLabel = `${dateRange.from.toLocaleDateString(locale)} – ${dateRange.to.toLocaleDateString(locale)}`;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <ReportHeader title={tr('pdf.productSales.title')} date={dateLabel} locale={locale} />
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.productSales.product')}</Text>
          <Text style={styles.cell}>{tr('pdf.productSales.category')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.productSales.units')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.productSales.revenue')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.productSales.margin')}</Text>
        </View>
        {rows.map((r, i) => (
          <View key={r.productName} style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}>
            <Text style={styles.cell}>{r.productName}</Text>
            <Text style={styles.cell}>{r.categoryName}</Text>
            <Text style={styles.cellRight}>{String(r.units)}</Text>
            <Text style={styles.cellRight}>{fmt(locale, r.revenue)}</Text>
            <Text style={styles.cellRight}>{r.margin !== null ? fmt(locale, r.margin) : '—'}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

function HourlySalesDoc({ rows, locale }: { rows: HourlyRow[]; locale: Locale }) {
  const tr = pdfT(locale);
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <ReportHeader
          title={tr('pdf.hourlySales.title')}
          date={new Date().toLocaleDateString(locale)}
          locale={locale}
        />
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.hourlySales.hour')}</Text>
          <Text style={styles.cell}>{tr('pdf.hourlySales.dayOfWeek')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.hourlySales.orders')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.hourlySales.revenue')}</Text>
          <Text style={styles.cell}>{tr('pdf.hourlySales.busiest')}</Text>
        </View>
        {rows.map((r, i) => (
          <View
            key={`${String(r.hour)}-${String(r.dayOfWeek)}`}
            style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}
          >
            <Text style={styles.cell}>{String(r.hour)}:00</Text>
            <Text style={styles.cell}>{String(r.dayOfWeek)}</Text>
            <Text style={styles.cellRight}>{String(r.orderCount)}</Text>
            <Text style={styles.cellRight}>{fmt(locale, r.revenue)}</Text>
            <Text style={styles.cell}>
              {r.isBusiest ? tr('pdf.hourlySales.busiestMarker') : ''}
            </Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

async function docToBytes(doc: React.ReactElement): Promise<Uint8Array> {
  // pdf() accepts React elements that render a Document — cast needed because
  // @react-pdf/renderer's TS signature is narrower than the actual runtime API.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = await pdf(doc as any).toBlob();
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function cajaReportToPdfBytes(report: CajaReport): Promise<Uint8Array> {
  const locale = getCurrentLocale();
  return docToBytes(React.createElement(CajaReportDoc, { report, locale }));
}

export async function productSalesToPdfBytes(
  rows: ProductSalesRow[],
  dateRange: { from: Date; to: Date }
): Promise<Uint8Array> {
  const locale = getCurrentLocale();
  return docToBytes(React.createElement(ProductSalesDoc, { rows, dateRange, locale }));
}

export async function hourlySalesToPdfBytes(rows: HourlyRow[]): Promise<Uint8Array> {
  const locale = getCurrentLocale();
  return docToBytes(React.createElement(HourlySalesDoc, { rows, locale }));
}

function VoidRefundDoc({
  rows,
  dateRange,
  locale,
}: {
  rows: VoidRefundRow[];
  dateRange: { from: Date; to: Date };
  locale: Locale;
}) {
  const tr = pdfT(locale);
  const dateLabel = `${dateRange.from.toLocaleDateString(locale)} – ${dateRange.to.toLocaleDateString(locale)}`;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <ReportHeader title={tr('pdf.voidRefund.title')} date={dateLabel} locale={locale} />
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.voidRefund.timestamp')}</Text>
          <Text style={styles.cell}>{tr('pdf.voidRefund.staff')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.voidRefund.amount')}</Text>
          <Text style={styles.cell}>{tr('pdf.voidRefund.reason')}</Text>
        </View>
        {rows.map((r, i) => (
          <View key={r.orderId} style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}>
            <Text style={styles.cell}>{r.voidedAt.toLocaleString(locale)}</Text>
            <Text style={styles.cell}>{r.staffName}</Text>
            <Text style={styles.cellRight}>{fmt(locale, r.amount)}</Text>
            <Text style={styles.cell}>{r.reason}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function voidRefundToPdfBytes(
  rows: VoidRefundRow[],
  dateRange: { from: Date; to: Date }
): Promise<Uint8Array> {
  const locale = getCurrentLocale();
  return docToBytes(React.createElement(VoidRefundDoc, { rows, dateRange, locale }));
}

function CategoryRevenueDoc({
  rows,
  dateRange,
  locale,
}: {
  rows: CategoryRevenueRow[];
  dateRange: { from: Date; to: Date };
  locale: Locale;
}) {
  const tr = pdfT(locale);
  const dateLabel = `${dateRange.from.toLocaleDateString(locale)} – ${dateRange.to.toLocaleDateString(locale)}`;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <ReportHeader title={tr('pdf.categoryRevenue.title')} date={dateLabel} locale={locale} />
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.categoryRevenue.category')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.categoryRevenue.units')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.categoryRevenue.orders')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.categoryRevenue.revenue')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.categoryRevenue.pctTotal')}</Text>
        </View>
        {rows.map((r, i) => (
          <View key={r.categoryId} style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}>
            <Text style={styles.cell}>{r.categoryName}</Text>
            <Text style={styles.cellRight}>{String(r.unitsSold)}</Text>
            <Text style={styles.cellRight}>{String(r.orderCount)}</Text>
            <Text style={styles.cellRight}>{fmt(locale, r.revenue)}</Text>
            <Text style={styles.cellRight}>{String(r.pctTotal)}%</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function categoryRevenueToPdfBytes(
  rows: CategoryRevenueRow[],
  dateRange: { from: Date; to: Date }
): Promise<Uint8Array> {
  const locale = getCurrentLocale();
  return docToBytes(React.createElement(CategoryRevenueDoc, { rows, dateRange, locale }));
}

function StaffMetricsDoc({
  rows,
  dateRange,
  locale,
}: {
  rows: StaffMetric[];
  dateRange: { from: Date; to: Date };
  locale: Locale;
}) {
  const tr = pdfT(locale);
  const dateLabel = `${dateRange.from.toLocaleDateString(locale)} – ${dateRange.to.toLocaleDateString(locale)}`;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <ReportHeader title={tr('pdf.staffMetrics.title')} date={dateLabel} locale={locale} />
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.staffMetrics.staffMember')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.staffMetrics.revenue')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.staffMetrics.transactions')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.staffMetrics.avgCheck')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.staffMetrics.voids')}</Text>
        </View>
        {rows.map((r, i) => (
          <View key={r.staffId} style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}>
            <Text style={styles.cell}>{r.staffName}</Text>
            <Text style={styles.cellRight}>{fmt(locale, r.revenue)}</Text>
            <Text style={styles.cellRight}>{String(r.transactionCount)}</Text>
            <Text style={styles.cellRight}>{fmt(locale, r.avgCheckSize)}</Text>
            <Text style={styles.cellRight}>{String(r.voidCount)}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function staffMetricsToPdfBytes(
  rows: StaffMetric[],
  dateRange: { from: Date; to: Date }
): Promise<Uint8Array> {
  const locale = getCurrentLocale();
  return docToBytes(React.createElement(StaffMetricsDoc, { rows, dateRange, locale }));
}

// Phase 8 S6-08 PDF builders

function RefundsRegisterDoc({
  rows,
  dateRange,
  locale,
}: {
  rows: RefundRegisterRow[];
  dateRange: { from: Date; to: Date };
  locale: Locale;
}) {
  const tr = pdfT(locale);
  const dateLabel = `${dateRange.from.toLocaleDateString(locale)} – ${dateRange.to.toLocaleDateString(locale)}`;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <ReportHeader title={tr('pdf.refundsRegister.title')} date={dateLabel} locale={locale} />
        <View style={styles.tableHeader}>
          <Text style={styles.cell}>{tr('pdf.refundsRegister.date')}</Text>
          <Text style={styles.cell}>{tr('pdf.refundsRegister.operator')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.refundsRegister.amount')}</Text>
          <Text style={styles.cell}>{tr('pdf.refundsRegister.reason')}</Text>
          <Text style={styles.cellRight}>{tr('pdf.refundsRegister.restock')}</Text>
        </View>
        {rows.map((r, i) => (
          <View key={r.id} style={[styles.row, i % 2 === 1 ? styles.rowAlt : {}]}>
            <Text style={styles.cell}>{new Date(r.date).toLocaleDateString(locale)}</Text>
            <Text style={styles.cell}>{r.operatorName}</Text>
            <Text style={styles.cellRight}>{fmt(locale, r.amount)}</Text>
            <Text style={styles.cell}>{r.reason}</Text>
            <Text style={styles.cellRight}>{String(r.restockCount)}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function refundsRegisterToPdfBytes(
  rows: RefundRegisterRow[],
  dateRange: { from: Date; to: Date }
): Promise<Uint8Array> {
  const locale = getCurrentLocale();
  return docToBytes(React.createElement(RefundsRegisterDoc, { rows, dateRange, locale }));
}
