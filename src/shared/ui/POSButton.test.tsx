/**
 * Unit tests for POSButton
 *
 * Tests: touchSize -> min-h class output (TOUCH-02 regression coverage), and that the
 * baseline focus-visible ring survives the touchSize className merge (FOCUS-01).
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { POSButton } from './POSButton';

describe('POSButton touchSize', () => {
  it('touchSize="default" renders min-h-[44px] and keeps the baseline focus ring', () => {
    render(<POSButton touchSize="default">Order</POSButton>);
    const button = screen.getByRole('button', { name: 'Order' });
    expect(button.className).toContain('min-h-[44px]');
    expect(button.className).toContain('focus-visible:ring-3');
  });

  it('touchSize="large" renders min-h-[56px] and text-base', () => {
    render(<POSButton touchSize="large">Order</POSButton>);
    const button = screen.getByRole('button', { name: 'Order' });
    expect(button.className).toContain('min-h-[56px]');
    expect(button.className).toContain('text-base');
  });

  it('touchSize="xl" renders min-h-[72px], text-lg, and font-semibold', () => {
    render(<POSButton touchSize="xl">Process Payment</POSButton>);
    const button = screen.getByRole('button', { name: 'Process Payment' });
    expect(button.className).toContain('min-h-[72px]');
    expect(button.className).toContain('text-lg');
    expect(button.className).toContain('font-semibold');
  });
});
