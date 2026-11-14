/**
 * DATA TABLE COMPONENT
 *
 * Generic table wrapper using TanStack Table.
 * Supports loading states, empty states, search, sorting, optional toolbar, and row clicks.
 */

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from '@tanstack/react-table';
import { FileQuestion } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@shared/lib/utils';

import { EmptyState } from './EmptyState';
import { TableRowSkeleton } from './LoadingSkeletons';
import { SearchInput } from './SearchInput';
import { TablePager } from './TablePager';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

export interface DataTableProps<T> {
  /** Column definitions */
  columns: ColumnDef<T>[];
  /** Table data */
  data: T[];
  /** Loading state - shows skeleton rows */
  isLoading?: boolean;
  /** Empty state component */
  emptyState?: React.ReactNode;
  /** Called when row is clicked */
  onRowClick?: (row: T) => void;
  /** Enable search functionality */
  searchable?: boolean;
  /** Search input placeholder */
  searchPlaceholder?: string;
  /** Enable column sorting (TanStack sorting state) */
  enableSorting?: boolean;
  /** Initial sorting state */
  initialSorting?: SortingState;
  /** Extra controls rendered above search/table (e.g. filters) */
  toolbar?: React.ReactNode;
  /** Per-data-row class names (e.g. highlight low stock) */
  getRowClassName?: (row: T) => string | undefined;
  /** Opt-in client-side paging; absent = every row renders (today's behaviour) */
  pageSize?: number | undefined;
  /** With pageSize: a changed key returns to page 1. A new data array with the same key keeps the page. */
  pageResetKey?: string | undefined;
  /** With pageSize: the original rows of the rendered page, reported from an effect */
  onPageRowsChange?: ((rows: T[]) => void) | undefined;
  /** Stable row identity (default: position). Needed for onPageRowsChange to notice swapped rows. */
  getRowId?: ((row: T) => string) | undefined;
  /** Additional CSS classes */
  className?: string;
}

/**
 * DataTable - Generic table component with TanStack Table
 */
export function DataTable<T>({
  columns,
  data,
  isLoading = false,
  emptyState,
  onRowClick,
  searchable = false,
  searchPlaceholder = 'Search...',
  enableSorting = false,
  initialSorting,
  toolbar,
  getRowClassName,
  pageSize,
  pageResetKey,
  onPageRowsChange,
  getRowId,
  className,
}: DataTableProps<T>) {
  const { t } = useTranslation('common');
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = React.useState('');
  const [sorting, setSorting] = React.useState<SortingState>(() => initialSorting ?? []);

  const [pageIndex, setPageIndex] = React.useState(0);
  // Return to page 1 when the caller's key, the search box or the sort changes (render-phase
  // reset: no frame is painted on a stale page, and a refetch alone never moves the page).
  const resetSig = JSON.stringify([pageResetKey, globalFilter, sorting, columnFilters]);
  const [prevResetSig, setPrevResetSig] = React.useState(resetSig);
  if (prevResetSig !== resetSig) {
    setPrevResetSig(resetSig);
    setPageIndex(0);
  }

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    ...(getRowId ? { getRowId } : {}),
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(pageSize
      ? { getPaginationRowModel: getPaginationRowModel(), autoResetPageIndex: false }
      : {}),
    ...(enableSorting
      ? {
          getSortedRowModel: getSortedRowModel(),
          onSortingChange: setSorting,
        }
      : {}),
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    state: {
      columnFilters,
      globalFilter,
      ...(enableSorting ? { sorting } : {}),
      ...(pageSize ? { pagination: { pageIndex, pageSize } } : {}),
    },
    enableSorting,
  });

  const pageCount = pageSize ? table.getPageCount() : 0;
  const lastPage = Math.max(pageCount - 1, 0);
  // data shrank (not in a reset render: pageIndex is stale there and the reset's 0 must win)
  if (pageSize && prevResetSig === resetSig && pageIndex > lastPage) setPageIndex(lastPage);

  // Held in a ref and keyed on the page's row ids, so an inline callback never loops.
  const onPageRowsChangeRef = React.useRef(onPageRowsChange);
  onPageRowsChangeRef.current = onPageRowsChange;
  const pageRows = table.getRowModel().rows;
  const pageRowsKey =
    pageSize || onPageRowsChange ? JSON.stringify(pageRows.map(row => row.id)) : '';
  React.useEffect(() => {
    onPageRowsChangeRef.current?.(pageRows.map(row => row.original));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pageRowsKey identifies pageRows
  }, [pageRowsKey]);

  const toolbarBlock = toolbar ? (
    <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
  ) : null;

  // Show loading state
  if (isLoading) {
    return (
      <div className={cn('space-y-4', className)}>
        {toolbarBlock}
        {searchable && <SearchInput value="" onChange={() => {}} placeholder={searchPlaceholder} />}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map(headerGroup => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map(header => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={columns.length} className="p-0">
                    <TableRowSkeleton columns={columns.length} className="border-b-0 px-4" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  }

  // Show empty state
  if (data.length === 0) {
    return (
      <div className={cn('space-y-4', className)}>
        {toolbarBlock}
        {searchable && (
          <SearchInput
            value={globalFilter}
            onChange={setGlobalFilter}
            placeholder={searchPlaceholder}
          />
        )}
        {emptyState || (
          <EmptyState
            icon={FileQuestion}
            title={t('dataTable.noDataTitle')}
            description={t('dataTable.noDataDescription')}
          />
        )}
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      {toolbarBlock}
      {searchable && (
        <SearchInput
          value={globalFilter}
          onChange={setGlobalFilter}
          placeholder={searchPlaceholder}
        />
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map(headerGroup => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map(header => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {emptyState || (
                    <EmptyState
                      icon={FileQuestion}
                      title={t('dataTable.noResultsTitle')}
                      description={t('dataTable.noResultsDescription')}
                    />
                  )}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map(row => (
                <TableRow
                  key={row.id}
                  // eslint-disable-next-line i18next/no-literal-string -- 'selected' is the Radix/Tailwind data-state value, not UI copy
                  data-state={row.getIsSelected() && 'selected'}
                  className={cn(onRowClick && 'cursor-pointer', getRowClassName?.(row.original))}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map(cell => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {pageSize ? (
        <TablePager page={pageIndex} pageCount={pageCount} onPageChange={setPageIndex} />
      ) : null}
    </div>
  );
}
