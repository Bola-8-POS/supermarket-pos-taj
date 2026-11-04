import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStoreSchemaStore } from '@shared/lib/store-schema/store';
import { StoreUpdatingBanner } from './StoreUpdatingBanner';

beforeEach(() => {
  useStoreSchemaStore.setState({ state: { kind: 'ok' }, checkedAt: 0 });
});

describe('StoreUpdatingBanner', () => {
  it('shows_a_status_strip_while_updating', () => {
    useStoreSchemaStore.setState({ state: { kind: 'updating' } });
    render(<StoreUpdatingBanner />);
    expect(screen.getByRole('status')).toHaveTextContent(/store is updating/i);
  });

  it.each(['ok', 'unreachable', 'missing'] as const)('is_hidden_for_%s', kind => {
    useStoreSchemaStore.setState({ state: { kind } });
    const { container } = render(<StoreUpdatingBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
