import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';
import { CategoryTreePicker, type CategoryPickerItem } from './CategoryTreePicker';

// ============================================================================
// FIXTURES
// ============================================================================

const ROOT_A: CategoryPickerItem = { id: 'a', parentId: null, name: 'Beer', color: '#FFA500' };
const ROOT_B: CategoryPickerItem = {
  id: 'b',
  parentId: null,
  name: 'Cocktails',
  color: '#FF1493',
};
const CHILD_A1: CategoryPickerItem = {
  id: 'a1',
  parentId: 'a',
  name: 'Lager',
  color: '#fbbf24',
};
const GRAND_A1A: CategoryPickerItem = {
  id: 'a1a',
  parentId: 'a1',
  name: 'Pale Lager',
  color: '#fef08a',
};

/** Finds the selection button (not the expand chevron) for a given node name (exact match). */
function getSelectBtn(name: string) {
  // Find button whose inner text span exactly matches the name
  const allBtns = screen.getAllByRole('button');
  const match = allBtns.find(
    btn =>
      !btn.getAttribute('aria-label')?.startsWith('Collapse') &&
      !btn.getAttribute('aria-label')?.startsWith('Expand') &&
      btn.querySelector('span.truncate')?.textContent?.trim() === name
  );
  if (match == null) {
    throw new Error(`Unable to find selection button for "${name}"`);
  }
  return match;
}

// ============================================================================
// TESTS
// ============================================================================

describe('CategoryTreePicker', () => {
  it('renders root-level nodes', () => {
    renderWithProviders(
      <CategoryTreePicker items={[ROOT_A, ROOT_B]} value={null} onChange={vi.fn()} />
    );
    expect(getSelectBtn('Beer')).toBeInTheDocument();
    expect(getSelectBtn('Cocktails')).toBeInTheDocument();
  });

  it('renders empty state when no items provided', () => {
    renderWithProviders(
      <CategoryTreePicker items={[]} value={null} onChange={vi.fn()} emptyText="Nothing here" />
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('shows tree role attributes', () => {
    renderWithProviders(
      <CategoryTreePicker items={[ROOT_A, ROOT_B]} value={null} onChange={vi.fn()} />
    );
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });

  it('calls onChange with the node id when a root node is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <CategoryTreePicker items={[ROOT_A, ROOT_B]} value={null} onChange={onChange} />
    );
    await user.click(getSelectBtn('Beer'));
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('calls onChange with null when the selected node is clicked again (deselect)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <CategoryTreePicker items={[ROOT_A, ROOT_B]} value="a" onChange={onChange} />
    );
    await user.click(getSelectBtn('Beer'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('marks selected node with aria-selected', () => {
    renderWithProviders(
      <CategoryTreePicker items={[ROOT_A, ROOT_B]} value="a" onChange={vi.fn()} />
    );
    const beerItem = screen.getByRole('treeitem', { name: /^Beer$/ });
    expect(beerItem).toHaveAttribute('aria-selected', 'true');
    const cocktailItem = screen.getByRole('treeitem', { name: /^Cocktails$/ });
    expect(cocktailItem).toHaveAttribute('aria-selected', 'false');
  });

  it('expands and shows children when expand button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CategoryTreePicker items={[ROOT_A, CHILD_A1]} value={null} onChange={vi.fn()} />
    );
    // 'a' is a root and starts expanded; child should be visible
    expect(getSelectBtn('Lager')).toBeInTheDocument();

    // Collapse 'a' by clicking its expand chevron
    const expandBtn = screen.getByRole('button', { name: 'Collapse Beer' });
    await user.click(expandBtn);
    expect(screen.queryByText('Lager')).not.toBeInTheDocument();

    // Expand again
    await user.click(screen.getByRole('button', { name: 'Expand Beer' }));
    expect(getSelectBtn('Lager')).toBeInTheDocument();
  });

  it('does not call onChange when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <CategoryTreePicker items={[ROOT_A]} value={null} onChange={onChange} disabled />
    );
    const btn = getSelectBtn('Beer');
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders 3-level deep tree correctly', () => {
    renderWithProviders(
      <CategoryTreePicker items={[ROOT_A, CHILD_A1, GRAND_A1A]} value={null} onChange={vi.fn()} />
    );
    expect(getSelectBtn('Beer')).toBeInTheDocument();
    expect(getSelectBtn('Lager')).toBeInTheDocument();
    expect(getSelectBtn('Pale Lager')).toBeInTheDocument();
  });

  it('calls onChange with child node id', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <CategoryTreePicker items={[ROOT_A, CHILD_A1]} value={null} onChange={onChange} />
    );
    await user.click(getSelectBtn('Lager'));
    expect(onChange).toHaveBeenCalledWith('a1');
  });
});
