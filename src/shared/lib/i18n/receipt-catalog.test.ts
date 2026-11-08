import { describe, expect, it } from 'vitest';
import enUS from './locales/en-US/receipt.json';
import esMX from './locales/es-MX/receipt.json';

function keyPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [prefix];
  return Object.entries(node).flatMap(([key, value]) =>
    keyPaths(value, prefix === '' ? key : `${prefix}.${key}`)
  );
}

describe('receipt catalogs', () => {
  it('es-MX and en-US receipt catalogs have identical keys', () => {
    expect(keyPaths(esMX).sort()).toEqual(keyPaths(enUS).sort());
  });
});
