/**
 * Unit tests for PageContainer
 *
 * Navigation moved into the app shell's sidebar; PageContainer no longer renders
 * a back link but still accepts the legacy backTo/backLabel props so existing
 * call sites keep compiling.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { PageContainer } from './PageContainer';

describe('PageContainer', () => {
  it('renders the title as a heading and its children', () => {
    render(
      <MemoryRouter>
        <PageContainer title="Inventory" description="Stock on hand">
          <div data-testid="child" />
        </PageContainer>
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Inventory' })).toBeInTheDocument();
    expect(screen.getByText('Stock on hand')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('renders no back link, even when the legacy backTo prop is provided', () => {
    render(
      <MemoryRouter>
        <PageContainer title="X" backTo="/home" backLabel="Home">
          <div data-testid="child" />
        </PageContainer>
      </MemoryRouter>
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders the actions slot', () => {
    render(
      <MemoryRouter>
        <PageContainer title="X" actions={<button type="button">Act</button>}>
          <div />
        </PageContainer>
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();
  });
});
