import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { Category } from '@entities/product/model/types';
import { cn } from '@shared/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '@shared/ui/tabs';

export interface CategoryTabsProps {
  categories: Category[];
  activeCategory: string | null;
  onChange: (categoryId: string | null) => void;
  className?: string;
}

const ALL_VALUE = '__all__';

const pillClass = (active: boolean) =>
  cn(
    'flex h-10 min-h-10 shrink-0 flex-none items-center gap-2 rounded-full border px-4 text-sm font-medium transition-[background-color,color,border-color,box-shadow] duration-150',
    active
      ? 'border-primary bg-primary text-primary-foreground shadow-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm dark:data-[state=active]:bg-primary'
      : 'border-border bg-card text-muted-foreground shadow-xs hover:border-border-strong hover:text-foreground dark:bg-input/20'
  );

export function CategoryTabs({
  categories,
  activeCategory,
  onChange,
  className,
}: CategoryTabsProps) {
  const { t } = useTranslation('entities');
  const allRef = React.useRef<HTMLButtonElement>(null);
  const categoryRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());

  const setCategoryRef = React.useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) categoryRefs.current.set(id, el);
    else categoryRefs.current.delete(id);
  }, []);

  React.useLayoutEffect(() => {
    const target =
      activeCategory === null ? allRef.current : (categoryRefs.current.get(activeCategory) ?? null);
    target?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [activeCategory, categories]);

  return (
    <Tabs
      value={activeCategory ?? ALL_VALUE}
      onValueChange={value => {
        onChange(value === ALL_VALUE ? null : value);
      }}
      className={className}
    >
      <TabsList className="h-auto w-full justify-start gap-2 overflow-x-auto overflow-y-hidden rounded-none bg-transparent p-0 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <TabsTrigger
          ref={allRef}
          value={ALL_VALUE}
          className={pillClass(activeCategory === null)}
          aria-label={t('categoryTabs.showAll')}
        >
          {t('categoryTabs.all')}
        </TabsTrigger>

        {categories.map(category => (
          <TabsTrigger
            key={category.id}
            ref={el => {
              setCategoryRef(category.id, el);
            }}
            value={category.id}
            className={pillClass(activeCategory === category.id)}
            aria-label={t('categoryTabs.filterBy', { category: category.name })}
          >
            <div
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: category.color }}
              aria-hidden="true"
            />
            {category.name}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
