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
  className,
}: DataTableProps<T>) {
  const { t } = useTranslation('common');
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = React.useState('');
  const [sorting, setSorting] = React.useState<SortingState>(() => initialSorting ?? []);

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
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
    },
    enableSorting,
  });

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
    </div>
  );
}
