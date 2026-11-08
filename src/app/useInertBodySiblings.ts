import { useEffect } from 'react';

const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

// Stacked gates share elements: inert goes on at 0 -> 1 owners and off only at 1 -> 0, so the first gate to unblock
// cannot re-expose #root or an open dialog while another wall is still up.
const owners = new Map<Element, number>();

/**
 * Radix dialogs (and toasts, banners) portal into document.body, outside the gate's own wrapper, so while the overlay
 * is up every other body child is made inert. A late arrival (a portal mounted after the block began) is caught by the
 * observer. `inert` does not stop key events reaching window-level listeners (Enter in a ConfirmDialog, F1 help, the
 * barcode scanner, PIN keypad), so one capture listener swallows every key (no preventDefault:
 * Enter/Space/Tab are default actions on the Try again button, which stopPropagation does not block). Focus goes to the gate's button (or the gate itself) last, after the inert
 * pass, so a Radix focus trap that fought us cannot leave it on body.
 * ponytail: an `inert` removed by its owner while gated is not re-applied; a Radix modal opening under the gate sets
 * aria-hidden on the gate. Upgrade to a focus-scope library only if either shows up in practice.
 */
export function useInertBodySiblings(host: HTMLElement | null, state: string): void {
  useEffect(() => {
    if (host === null) return;
    const touched = new Set<Element>();
    const apply = (): void => {
      for (const el of Array.from(document.body.children)) {
        if (el === host || touched.has(el) || el.hasAttribute('data-gate-overlay')) continue; // another gate's overlay stays live
        const n = owners.get(el) ?? 0;
        if (n === 0 && el.hasAttribute('inert')) continue; // inert by its own owner: not ours to clear
        owners.set(el, n + 1);
        if (n === 0) el.setAttribute('inert', '');
        touched.add(el);
      }
    };
    const swallow = (e: Event): void => {
      e.stopPropagation(); // every key, the gate's button included: the gate has no key handlers of its own
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true });
    KEY_EVENTS.forEach(t => {
      window.addEventListener(t, swallow, true);
    });
    (host.querySelector('button') ?? host).focus();
    return () => {
      observer.disconnect();
      KEY_EVENTS.forEach(t => {
        window.removeEventListener(t, swallow, true);
      });
      touched.forEach(el => {
        const n = (owners.get(el) ?? 1) - 1;
        if (n > 0) {
          owners.set(el, n);
          return;
        }
        owners.delete(el);
        el.removeAttribute('inert');
      });
    };
  }, [host, state]);
}
