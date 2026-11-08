import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category } from '@entities/category';
import '@shared/lib/i18n';

const createMutateAsync = vi.fn();
const updateMutateAsync = vi.fn();

const CATEGORY_A: Category = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Snacks',
  color: '#6366f1',
  sortOrder: 0,
  happyHourStart: null,
  happyHourEnd: null,
  routing: 'NONE',
  parentId: null,
  comboEligible: true,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

const CATEGORY_B: Category = {
  ...CATEGORY_A,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Frozen',
  comboEligible: false,
};

let categoriesData: Category[] = [CATEGORY_A];

vi.mock('@entities/category', () => ({
  useCategories: () => ({ data: categoriesData, isLoading: false, resultError: undefined }),
  useMutationCreateCategory: () => ({ mutateAsync: createMutateAsync, isPending: false }),
  useMutationUpdateCategory: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
}));

const { CategoryTreeEditor } = await import('./CategoryTreeEditor');

describe('CategoryTreeEditor — combo eligible', () => {
  beforeEach(() => {
    createMutateAsync.mockReset().mockResolvedValue({ ok: true, data: null });
    updateMutateAsync.mockReset().mockResolvedValue({ ok: true, data: null });
    categoriesData = [CATEGORY_A];
  });

  it('sends comboEligible:false through the update mutation when unchecked', async () => {
    render(<CategoryTreeEditor />);

    await userEvent.click(screen.getByRole('button', { name: /edit snacks/i }));
    const comboCheckbox = screen.getByLabelText(/combo eligible/i);
    expect(comboCheckbox).toBeChecked();
    await userEvent.click(comboCheckbox);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(updateMutateAsync.mock.calls[0]?.[0]).toMatchObject({
      id: CATEGORY_A.id,
      comboEligible: false,
    });
  });

  it('shows a "No combos" tag on a row whose category is combo-ineligible', () => {
    categoriesData = [CATEGORY_B];
    render(<CategoryTreeEditor />);
    expect(screen.getByText(/no combos/i)).toBeInTheDocument();
  });
});
