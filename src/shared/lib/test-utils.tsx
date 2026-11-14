/**
 * TEST UTILITIES
 *
 * Helper functions for testing components with React Testing Library.
 * Provides wrappers for QueryClient, Zustand stores, and other providers.
 */

/* eslint-disable react-refresh/only-export-components -- test-only helpers, not components */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

/**
 * Creates a new QueryClient for testing
 * Disables retries and sets staleTime to Infinity for predictable tests
 */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * AllTheProviders - Wraps component in all necessary providers
 */
interface AllTheProvidersProps {
  children: ReactNode;
  queryClient?: QueryClient;
}

function AllTheProviders({ children, queryClient }: AllTheProvidersProps) {
  const client = queryClient || createTestQueryClient();

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Custom render options
 */
interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  queryClient?: QueryClient;
}

/**
 * renderWithProviders - Renders component with all providers
 *
 * @example
 * ```tsx
 * import { renderWithProviders } from '@shared/lib/test-utils';
 *
 * test('renders product list', () => {
 *   const { getByText } = renderWithProviders(<ProductList />);
 *   expect(getByText('Beer')).toBeInTheDocument();
 * });
 * ```
 */
export function renderWithProviders(ui: ReactElement, options?: CustomRenderOptions) {
  const { queryClient, ...renderOptions } = options || {};

  return render(ui, {
    wrapper: ({ children }) => (
      <AllTheProviders {...(queryClient ? { queryClient } : {})}>{children}</AllTheProviders>
    ),
    ...renderOptions,
  });
}
