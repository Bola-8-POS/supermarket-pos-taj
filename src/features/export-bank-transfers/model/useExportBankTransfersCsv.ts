/**
 * useExportBankTransfersCsv — Tauri-native CSV export for the Bank Transfers
 * list (D-13/BTP-08). Mirrors useExportReport.ts's exact save()+writeFile()
 * pattern verbatim: never a browser-download anti-pattern (object-URL + <a>).
 */
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { useState } from 'react';
import { toast } from 'sonner';

import type { BankTransfer } from '@entities/bank-transfer';
import { csvToBytes, rowsToCsv, type CsvColumn } from '@shared/lib/exporters/csv';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { ok, err, exportCancelledError, exportFailedError, type Result } from '@shared/lib/result';

type BankTransferCsvRow = {
  referenceCode: string;
  customerName: string;
  customerPhone: string;
  amount: number;
  status: string;
  createdAt: string;
  confirmedBy: string;
};

function buildColumns(t: typeof i18n.t): CsvColumn<BankTransferCsvRow>[] {
  return [
    { key: 'referenceCode', header: t('wAdmin:bankTransfersList.columnReference') },
    { key: 'customerName', header: t('wAdmin:bankTransfersList.columnCustomer') },
    // eslint-disable-next-line i18next/no-literal-string -- exported CSV column header, not UI copy
    { key: 'customerPhone', header: 'Phone' },
    { key: 'amount', header: t('wAdmin:bankTransfersList.columnAmount') },
    { key: 'status', header: t('wAdmin:bankTransfersList.columnStatus') },
    // eslint-disable-next-line i18next/no-literal-string -- exported CSV column header, not UI copy
    { key: 'createdAt', header: 'Created At' },
    // eslint-disable-next-line i18next/no-literal-string -- exported CSV column header, not UI copy
    { key: 'confirmedBy', header: 'Confirmed By' },
  ];
}

export function useExportBankTransfersCsv() {
  const [isExporting, setIsExporting] = useState(false);

  async function exportBankTransfersCsv(transfers: BankTransfer[]): Promise<Result<void>> {
    setIsExporting(true);
    try {
      // D-13: only pending + confirmed rows are reconciliation-relevant for an
      // end-of-day export — a disputed transfer never becomes real revenue.
      const rows: BankTransferCsvRow[] = transfers
        .filter(tr => tr.status !== 'disputed')
        .map(tr => ({
          referenceCode: tr.referenceCode,
          customerName: tr.customerName,
          customerPhone: tr.customerPhone ?? '',
          amount: tr.amount,
          status: i18n.t(`wAdmin:bankTransfersList.status.${tr.status}`),
          createdAt: tr.createdAt.toLocaleString(),
          confirmedBy: tr.confirmedByName ?? '',
        }));

      const bytes = csvToBytes(rowsToCsv(rows, buildColumns(i18n.t)));
      // eslint-disable-next-line i18next/no-literal-string -- ISO-date split delimiter/fallback, not UI copy
      const dateStr = new Date().toISOString().split('T')[0] ?? 'export';

      // eslint-disable-next-line i18next/no-literal-string -- file extension technical value, not UI copy
      const csvExtensions = ['csv'];
      const filePath = await save({
        // eslint-disable-next-line i18next/no-literal-string -- generated filename, not UI copy
        defaultPath: `bank-transfers-${dateStr}.csv`,
        filters: [{ name: i18n.t('wAdmin:bankTransfersList.csvFileLabel'), extensions: csvExtensions }],
      });

      if (filePath === null) {
        return err(exportCancelledError());
      }

      await writeFile(filePath, bytes);

      toast.success(i18n.t('wAdmin:bankTransfersList.exportSuccessToast'));
      logger.info('export.bank_transfers.success', { count: rows.length });
      return ok(undefined);
    } catch (e) {
      logger.error('export.bank_transfers.failed', { raw: e });
      toast.error(i18n.t('wAdmin:bankTransfersList.exportErrorToast'));
      return err(exportFailedError(undefined, e));
    } finally {
      setIsExporting(false);
    }
  }

  return { exportBankTransfersCsv, isExporting };
}
