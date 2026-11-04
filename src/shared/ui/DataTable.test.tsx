/**
 * Unit tests for DataTable opt-in pagination.
 */

import type { ColumnDef } from '@tanstack/react-table';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DataTable } from './DataTable';

type Row = { id: string; name: string };

const columns: ColumnDef<Row>[] = [{ id: 'name', accessorKey: 'name', header: 'Name' }];

const names = ['Eve', 'Bob', 'Dan', 'Cat', 'Abe'];
const rows = (list: string[] = names): Row[] => list.map((name, i) => ({ id: String(i), name }));

const bodyNames = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map(r => r.textContent);

const next = () => fireEvent.click(screen.getByRole('button', { name: /next|siguiente/i }));
const hasPager = () => screen.queryByRole('button', { name: /next|siguiente/i }) !== null;

describe('DataTable pagination', () => {
  it('without pageSize renders every row and no pager', () => {
    render(<DataTable columns={columns} data={rows()} />);
    expect(bodyNames()).toEqual(names);
    expect(hasPager()).toBe(false);
  });

  it('with pageSize 2 and five rows renders two rows, a pager, and next shows rows three and four', () => {
    render(<DataTable columns={columns} data={rows()} pageSize={2} />);
    expect(bodyNames()).toEqual(['Eve', 'Bob']);
    expect(hasPager()).toBe(true);
    next();
    expect(bodyNames()).toEqual(['Dan', 'Cat']);
  });

  it('searching narrows over all rows, not the current page', async () => {
    render(<DataTable columns={columns} data={rows()} pageSize={2} searchable />);
    next();
    next(); // page 3 holds Abe
    expect(bodyNames()).toEqual(['Abe']);
    // 'a' matches Dan, Cat, Abe (3 rows = 2 pages): the result lands on page 1 of the matches
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a' } });
    await waitFor(() => {
      expect(bodyNames()).toEqual(['Dan', 'Cat']);
    });
    expect(hasPager()).toBe(true);
  });

  it('data becoming empty shows no pager and a later refill starts on page one', () => {
    const { rerender } = render(<DataTable columns={columns} data={rows()} pageSize={2} />);
    next();
    rerender(<DataTable columns={columns} data={[]} pageSize={2} />);
    expect(hasPager()).toBe(false);
    rerender(<DataTable columns={columns} data={rows()} pageSize={2} />);
    expect(bodyNames()).toEqual(['Eve', 'Bob']);
  });

  it('landing exactly on the last page keeps the pager and a focusable Next', () => {
    render(<DataTable columns={columns} data={rows(names.slice(0, 4))} pageSize={2} />);
    const nextBtn = screen.getByRole('button', { name: /next|siguiente/i });
    nextBtn.focus();
    fireEvent.click(nextBtn);
    expect(bodyNames()).toEqual(['Dan', 'Cat']);
    expect(nextBtn).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(nextBtn);
    fireEvent.click(nextBtn);
    expect(bodyNames()).toEqual(['Dan', 'Cat']);
  });

  it('onPageRowsChange fires when the caller swaps the page for different rows (getRowId)', () => {
    const spy = vi.fn();
    const a = [
      { id: 'a1', name: 'A1' },
      { id: 'a2', name: 'A2' },
    ];
    const b = [
      { id: 'b1', name: 'B1' },
      { id: 'b2', name: 'B2' },
    ];
    const { rerender } = render(
      <DataTable
        columns={columns}
        data={a}
        pageSize={2}
        getRowId={r => r.id}
        onPageRowsChange={spy}
      />
    );
    rerender(
      <DataTable
        columns={columns}
        data={b}
        pageSize={2}
        getRowId={r => r.id}
        onPageRowsChange={spy}
      />
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(b);
  });

  it('sorting is applied before paging', () => {
    render(
      <DataTable
        columns={columns}
        data={rows()}
        pageSize={2}
        enableSorting
        initialSorting={[{ id: 'name', desc: false }]}
      />
    );
    expect(bodyNames()).toEqual(['Abe', 'Bob']);
  });

  it('the page clamps when data shrinks (a filter change resets: see the search test)', () => {
    const { rerender } = render(
      <DataTable columns={columns} data={rows()} pageSize={2} searchable />
    );
    next();
    next();
    expect(bodyNames()).toEqual(['Abe']);
    rerender(
      <DataTable columns={columns} data={rows(names.slice(0, 3))} pageSize={2} searchable />
    );
    expect(bodyNames()).toEqual(['Dan']); // clamped from page 3 to page 2
  });

  it('onPageRowsChange receives exactly the rendered rows on mount, next and search', async () => {
    const spy = vi.fn();
    render(
      <DataTable columns={columns} data={rows()} pageSize={2} searchable onPageRowsChange={spy} />
    );
    expect(spy).toHaveBeenLastCalledWith([rows()[0], rows()[1]]);
    next();
    expect(spy).toHaveBeenLastCalledWith([rows()[2], rows()[3]]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Abe' } });
    await waitFor(() => {
      expect(spy).toHaveBeenLastCalledWith([rows()[4]]);
    });
  });

  it('a refetch with the same rows in a new array keeps the page', () => {
    const { rerender } = render(<DataTable columns={columns} data={rows()} pageSize={2} />);
    next();
    rerender(<DataTable columns={columns} data={rows()} pageSize={2} />);
    expect(bodyNames()).toEqual(['Dan', 'Cat']);
  });

  it('no re-render loop with an inline callback', () => {
    const calls = vi.fn();
    let renders = 0;
    const cols: ColumnDef<Row>[] = [
      {
        id: 'name',
        header: 'Name',
        cell: () => {
          renders += 1;
          return 'x';
        },
      },
    ];
    const data = rows();
    function Host() {
      const [, setSeen] = React.useState<Row[]>([]);
      return (
        <DataTable
          columns={cols}
          data={data}
          pageSize={2}
          onPageRowsChange={r => {
            calls(r);
            setSeen(r); // state update from the callback re-renders the host with a fresh arrow
          }}
        />
      );
    }
    render(<Host />);
    next();
    expect(calls).toHaveBeenCalledTimes(2); // mount + next
    expect(renders).toBeLessThan(20);
  });

  it('a changed pageResetKey returns to page one', () => {
    const { rerender } = render(
      <DataTable columns={columns} data={rows()} pageSize={2} pageResetKey="a" />
    );
    next();
    expect(bodyNames()).toEqual(['Dan', 'Cat']);
    rerender(<DataTable columns={columns} data={rows()} pageSize={2} pageResetKey="b" />);
    expect(bodyNames()).toEqual(['Eve', 'Bob']);
  });
});
