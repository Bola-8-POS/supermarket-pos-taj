import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateMockCategory, MOCK_IDS } from '@shared/lib/mocks';
import { CategoryTabs } from './CategoryTabs';

const scrollIntoViewMock = vi.fn();

const mockCategories = [
  generateMockCategory({
    id: MOCK_IDS.categoryBeer,
    name: 'Beer',
    color: '#FFA500',
    sortOrder: 1,
    happyHourStart: '16:00',
    happyHourEnd: '19:00',
  }),
  generateMockCategory({
    id: MOCK_IDS.categorySpirits,
    name: 'Cocktails',
    color: '#FF1493',
    sortOrder: 2,
    happyHourStart: '16:00',
    happyHourEnd: '19:00',
  }),
  generateMockCategory({
    id: MOCK_IDS.categoryMixers,
    name: 'Shots',
    color: '#8B0000',
    sortOrder: 3,
    happyHourStart: null,
    happyHourEnd: null,
  }),
];

describe('CategoryTabs', () => {
  beforeEach(() => {
    scrollIntoViewMock.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock,
    });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: typeof scrollIntoViewMock })
      .scrollIntoView;
  });

  it('renders "All" tab and category tabs', () => {
    const onChange = vi.fn();
    render(<CategoryTabs categories={mockCategories} activeCategory={null} onChange={onChange} />);

    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Beer')).toBeInTheDocument();
    expect(screen.getByText('Cocktails')).toBeInTheDocument();
    expect(screen.getByText('Shots')).toBeInTheDocument();
  });

  it('applies active styling to "All" tab when activeCategory is null', () => {
    const onChange = vi.fn();
    render(<CategoryTabs categories={mockCategories} activeCategory={null} onChange={onChange} />);

    const allButton = screen.getByText('All');
    expect(allButton).toHaveClass('bg-primary', 'text-primary-foreground');
  });

  it('applies active styling to selected category tab', () => {
    const onChange = vi.fn();
    render(
      <CategoryTabs
        categories={mockCategories}
        activeCategory={MOCK_IDS.categorySpirits}
        onChange={onChange}
      />
    );

    const cocktailsButton = screen.getByText('Cocktails');
    expect(cocktailsButton).toHaveClass('bg-primary', 'text-primary-foreground');
  });

  it('calls onChange with null when "All" tab is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CategoryTabs
        categories={mockCategories}
        activeCategory={MOCK_IDS.categoryBeer}
        onChange={onChange}
      />
    );

    await user.click(screen.getByText('All'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('calls onChange with category id when category tab is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CategoryTabs categories={mockCategories} activeCategory={null} onChange={onChange} />);

    await user.click(screen.getByText('Beer'));
    expect(onChange).toHaveBeenCalledWith(MOCK_IDS.categoryBeer);
  });

  it('supports keyboard navigation with Enter key', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CategoryTabs categories={mockCategories} activeCategory={null} onChange={onChange} />);

    const beerButton = screen.getByText('Beer');
    beerButton.focus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(MOCK_IDS.categoryBeer);
  });

  it('supports keyboard navigation with arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CategoryTabs
        categories={mockCategories}
        activeCategory={MOCK_IDS.categoryBeer}
        onChange={onChange}
      />
    );

    screen.getByText('Beer').focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith(MOCK_IDS.categorySpirits);
  });

  it('renders category color dots', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CategoryTabs categories={mockCategories} activeCategory={null} onChange={onChange} />
    );

    const colorDots = container.querySelectorAll('.h-2.w-2.rounded-full');
    expect(colorDots).toHaveLength(3);
  });

  it('has proper ARIA labels', () => {
    const onChange = vi.fn();
    render(
      <CategoryTabs
        categories={mockCategories}
        activeCategory={MOCK_IDS.categoryBeer}
        onChange={onChange}
      />
    );

    expect(screen.getByLabelText('Show all categories')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by Beer')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by Cocktails')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by Shots')).toBeInTheDocument();
  });

  it('sets aria-selected correctly for active tab', () => {
    const onChange = vi.fn();
    render(
      <CategoryTabs
        categories={mockCategories}
        activeCategory={MOCK_IDS.categorySpirits}
        onChange={onChange}
      />
    );

    const cocktailsButton = screen.getByText('Cocktails');
    expect(cocktailsButton).toHaveAttribute('aria-selected', 'true');

    const beerButton = screen.getByText('Beer');
    expect(beerButton).toHaveAttribute('aria-selected', 'false');
  });

  it('scrolls active category tab into view when activeCategory changes', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CategoryTabs categories={mockCategories} activeCategory={null} onChange={onChange} />
    );

    rerender(
      <CategoryTabs
        categories={mockCategories}
        activeCategory={MOCK_IDS.categoryMixers}
        onChange={onChange}
      />
    );

    expect(scrollIntoViewMock).toHaveBeenCalled();
  });
});
