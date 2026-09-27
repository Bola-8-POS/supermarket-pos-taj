/* eslint-disable no-console -- story actions */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { generateMockCategory, MOCK_IDS } from '@shared/lib/mocks';
import { CategoryTabs } from './CategoryTabs';

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

const meta = {
  title: 'Entities/Product/CategoryTabs',
  component: CategoryTabs,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    onChange: (id: string | null) => {
      console.log('Category changed', id);
    },
  },
} satisfies Meta<typeof CategoryTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllSelected: Story = {
  args: {
    categories: mockCategories,
    activeCategory: null,
  },
};

export const BeerSelected: Story = {
  args: {
    categories: mockCategories,
    activeCategory: MOCK_IDS.categoryBeer,
  },
};

export const CocktailsSelected: Story = {
  args: {
    categories: mockCategories,
    activeCategory: MOCK_IDS.categorySpirits,
  },
};

export const ShotsSelected: Story = {
  args: {
    categories: mockCategories,
    activeCategory: MOCK_IDS.categoryMixers,
  },
};

export const EmptyCategories: Story = {
  args: {
    categories: [],
    activeCategory: null,
  },
};

export const ManyCategories: Story = {
  args: {
    categories: [
      ...mockCategories,
      generateMockCategory({
        id: 'b0000000-0000-4000-8000-000000000099',
        name: 'Wine',
        color: '#800020',
        sortOrder: 4,
        happyHourStart: null,
        happyHourEnd: null,
      }),
      generateMockCategory({
        id: 'b0000000-0000-4000-8000-000000000098',
        name: 'Spirits',
        color: '#FFD700',
        sortOrder: 5,
        happyHourStart: null,
        happyHourEnd: null,
      }),
      generateMockCategory({
        id: 'b0000000-0000-4000-8000-000000000097',
        name: 'Non-Alcoholic',
        color: '#00CED1',
        sortOrder: 6,
        happyHourStart: null,
        happyHourEnd: null,
      }),
      generateMockCategory({
        id: 'b0000000-0000-4000-8000-000000000096',
        name: 'Snacks',
        color: '#FF6347',
        sortOrder: 7,
        happyHourStart: null,
        happyHourEnd: null,
      }),
    ],
    activeCategory: null,
  },
};
