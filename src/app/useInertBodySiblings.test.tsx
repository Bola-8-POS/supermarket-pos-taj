import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useInertBodySiblings } from './useInertBodySiblings';

function mk(overlay: boolean): HTMLElement {
  const el = document.createElement('div');
  if (overlay) el.setAttribute('data-gate-overlay', '');
  el.appendChild(document.createElement('button'));
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useInertBodySiblings with stacked gates', () => {
  it('siblings stay inert until the last gate unblocks', () => {
    const root = mk(false);
    const dialog = mk(false);
    const hostA = mk(true);
    const hostB = mk(true);
    const a = renderHook(() => { useInertBodySiblings(hostA, 'x'); });
    const b = renderHook(() => { useInertBodySiblings(hostB, 'x'); });
    expect(root).toHaveAttribute('inert');
    expect(dialog).toHaveAttribute('inert');
    a.unmount();
    expect(root).toHaveAttribute('inert'); // the other wall is still up
    expect(dialog).toHaveAttribute('inert');
    b.unmount();
    expect(root).not.toHaveAttribute('inert');
    expect(dialog).not.toHaveAttribute('inert');
  });

  it('an element inert before any gate stays inert after', () => {
    const owned = mk(false);
    owned.setAttribute('inert', '');
    const host = mk(true);
    const g = renderHook(() => { useInertBodySiblings(host, 'x'); });
    g.unmount();
    expect(owned).toHaveAttribute('inert');
  });
});
