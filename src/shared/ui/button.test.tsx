/**
 * Unit tests for Button
 *
 * Tests: focusEmphasis CVA variant class output (FOCUS-01/FOCUS-02, closes Assumption A1).
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from './button';

describe('Button focusEmphasis', () => {
  it('focusEmphasis="high" renders the emphasized focus-visible ring', () => {
    render(<Button focusEmphasis="high">Delete</Button>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.className).toContain('focus-visible:ring-4');
    expect(button.className).toContain('focus-visible:ring-ring');
    expect(button.className).not.toContain('ring-ring/50');
  });

  it('focusEmphasis="default" keeps the baseline focus-visible ring', () => {
    render(<Button focusEmphasis="default">Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toContain('focus-visible:ring-3');
    expect(button.className).toContain('focus-visible:ring-ring/50');
  });

  it('a plain Button with no focusEmphasis keeps the baseline focus-visible ring', () => {
    render(<Button>Plain</Button>);
    const button = screen.getByRole('button', { name: 'Plain' });
    expect(button.className).toContain('focus-visible:ring-3');
    expect(button.className).toContain('focus-visible:ring-ring/50');
  });
});
