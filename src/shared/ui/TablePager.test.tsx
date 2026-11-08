import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@shared/lib/i18n';
import { TablePager } from './TablePager';

describe('TablePager', () => {
  it('is a labelled navigation landmark', () => {
    render(<TablePager page={0} pageCount={3} onPageChange={() => undefined} />);
    expect(screen.getByRole('navigation', { name: /paginaci|pagination/i })).toBeInTheDocument();
  });
});
