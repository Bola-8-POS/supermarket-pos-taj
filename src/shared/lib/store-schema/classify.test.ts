import { describe, expect, it } from 'vitest';
import { classify } from './classify';

const B = { maxVersion: '20261018000004', applied: 266 };

describe('classify', () => {
  it('equal_is_ok', () => {
    expect(classify({ ...B }, B)).toBe('ok');
  });
  it('older_server_is_server_outdated', () => {
    expect(classify({ maxVersion: '20261001000001', applied: 250 }, B)).toBe('server-outdated');
  });
  it('newer_server_is_client_outdated', () => {
    expect(classify({ maxVersion: '20261101000001', applied: 270 }, B)).toBe('client-outdated');
  });
  it('one_field_off_is_inconsistent', () => {
    expect(classify({ maxVersion: B.maxVersion, applied: 265 }, B)).toBe('inconsistent');
    expect(classify({ maxVersion: '20261001000001', applied: 266 }, B)).toBe('inconsistent');
    expect(classify({ maxVersion: '20261101000001', applied: 250 }, B)).toBe('inconsistent');
  });
});
