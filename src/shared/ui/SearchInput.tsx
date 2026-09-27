/**
 * SEARCH INPUT COMPONENT
 *
 * Search input with debouncing and clear button.
 */

import { Search, X } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@shared/lib/utils';

import { Button } from './button';
import { Input } from './input';

export interface SearchInputProps {
  /** Current search value */
  value: string;
  /** Called when search value changes (debounced) */
  onChange: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs?: number;
  /** Additional CSS classes */
  className?: string;
}

/**
 * SearchInput - Debounced search input with clear button
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  debounceMs = 300,
  className,
}: SearchInputProps) {
  const { t } = useTranslation('common');
  const [localValue, setLocalValue] = React.useState(value);
  const timeoutRef = React.useRef<NodeJS.Timeout | undefined>(undefined);

  // Sync external value changes
  React.useEffect(() => {
    setLocalValue(value);
  }, [value]);

  // Debounced onChange
  const handleChange = React.useCallback(
    (newValue: string) => {
      setLocalValue(newValue);

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        onChange(newValue);
      }, debounceMs);
    },
    [onChange, debounceMs]
  );

  const handleClear = React.useCallback(() => {
    setLocalValue('');
    onChange('');
    if (timeoutRef.current !== undefined) {
      clearTimeout(timeoutRef.current);
    }
  }, [onChange]);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current !== undefined) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div className={cn('group/search relative', className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within/search:text-brand"
        aria-hidden="true"
      />

      <Input
        type="text"
        value={localValue}
        onChange={e => {
          handleChange(e.target.value);
        }}
        placeholder={placeholder}
        className="pr-11 pl-10"
        aria-label={t('searchInput.search')}
      />

      {localValue && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-1/2 right-1 size-9 -translate-y-1/2 touch-manipulation rounded-md text-muted-foreground"
          onClick={handleClear}
          aria-label={t('searchInput.clear')}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
