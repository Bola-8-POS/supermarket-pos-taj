import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { generateMockCategory, generateMockProduct, MOCK_IDS } from '@shared/lib/mocks';
import { ProductCard } from './ProductCard';

describe('ProductCard', () => {
  it('renders the product base price', () => {
    const category = generateMockCategory({ id: MOCK_IDS.categoryBeer });
    const product = generateMockProduct({
      categoryId: category.id,
      category,
      basePrice: 5.5,
      isActive: true,
    });

    render(<ProductCard product={product} category={category} onSelect={vi.fn()} />);

    expect(screen.getByLabelText('$5.50 dollars')).toBeInTheDocument();
  });

  it('does not render a happy hour badge', () => {
    const category = generateMockCategory({ id: MOCK_IDS.categoryBeer });
    const product = generateMockProduct({
      categoryId: category.id,
      category,
      isActive: true,
    });
    const now = new Date('2024-06-15T17:30:00');

    render(<ProductCard product={product} category={category} now={now} onSelect={vi.fn()} />);

    expect(screen.queryByText('HAPPY HOUR')).not.toBeInTheDocument();
  });

  it('calls onSelect when tapped', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const category = generateMockCategory({ id: MOCK_IDS.categoryBeer });
    const product = generateMockProduct({
      categoryId: category.id,
      category,
      isActive: true,
    });

    render(<ProductCard product={product} category={category} onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: /Select Heineken/i }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(product);
  });
});
