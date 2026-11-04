import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as licenseConfig from './license/config';
import { DEFAULT_TERMINAL_ID, TERMINAL_ID_STORAGE_KEY, getTerminalId, setTerminalId } from './terminal';

describe('terminal identity', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('falls back to POS-1 when nothing is configured', () => {
    expect(getTerminalId()).toBe(DEFAULT_TERMINAL_ID);
  });
  it('prefers VITE_TERMINAL_ID over the default', () => {
    vi.stubEnv('VITE_TERMINAL_ID', 'POS-9');
    expect(getTerminalId()).toBe('POS-9');
  });
  it('prefers localStorage over the env var', () => {
    vi.stubEnv('VITE_TERMINAL_ID', 'POS-9');
    localStorage.setItem(TERMINAL_ID_STORAGE_KEY, 'CAJA_2');
    expect(getTerminalId()).toBe('CAJA_2');
  });
  it('setTerminalId persists a valid id and trims it', () => {
    expect(setTerminalId('  POS-2 ').ok).toBe(true);
    expect(getTerminalId()).toBe('POS-2');
  });
  it('setTerminalId rejects invalid ids', () => {
    expect(setTerminalId('').ok).toBe(false);
    expect(setTerminalId('has space').ok).toBe(false);
    expect(setTerminalId('x'.repeat(33)).ok).toBe(false);
    expect(getTerminalId()).toBe(DEFAULT_TERMINAL_ID);
  });
  it('ignores a corrupted localStorage value', () => {
    localStorage.setItem(TERMINAL_ID_STORAGE_KEY, 'bad value!');
    expect(getTerminalId()).toBe(DEFAULT_TERMINAL_ID);
  });

  it('mints and persists a DEMO- terminal id when demo auto-start is on', () => {
    vi.spyOn(licenseConfig, 'isDemoAutoStart').mockReturnValue(true);
    const first = getTerminalId();
    expect(first).toMatch(/^DEMO-[0-9a-f]{6}$/);
    expect(getTerminalId()).toBe(first);
  });

  it('stays POS-1 when demo auto-start is off', () => {
    vi.spyOn(licenseConfig, 'isDemoAutoStart').mockReturnValue(false);
    expect(getTerminalId()).toBe(DEFAULT_TERMINAL_ID);
  });
});
