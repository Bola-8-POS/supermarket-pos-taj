import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@shared/lib/i18n';
import { resetStoreRuntimeConfigForTests, setStoreRuntimeConfig } from '@shared/lib/store-mode';
import { StoreConfigBanner } from './StoreConfigBanner';

afterEach(async () => {
  resetStoreRuntimeConfigForTests();
  await i18n.changeLanguage('en-US');
});

describe('StoreConfigBanner', () => {
  it('renders nothing for a healthy till', () => {
    setStoreRuntimeConfig({ storeMode: 'cloud' });
    const { container } = render(<StoreConfigBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for the ignored untrusted-owner / untrusted-path codes', () => {
    for (const code of ['STORE_ENV_UNTRUSTED_OWNER', 'STORE_ENV_UNTRUSTED_PATH']) {
      setStoreRuntimeConfig({ storeMode: 'cloud', storeConfigError: code });
      const { container } = render(<StoreConfigBanner />);
      expect(container).toBeEmptyDOMElement();
    }
  });

  it('shows the code, a reason and the fix instruction in English', () => {
    setStoreRuntimeConfig({ storeMode: 'cloud', storeConfigError: 'STORE_MODE_UNKNOWN' });
    render(<StoreConfigBanner />);
    const bar = screen.getByTestId('store-config-banner');
    expect(bar).toHaveAttribute('role', 'alert');
    expect(bar).toHaveAttribute('data-code', 'STORE_MODE_UNKNOWN');
    expect(bar).toHaveTextContent('store.env is invalid');
    expect(bar).toHaveTextContent('STORE_MODE_UNKNOWN');
    expect(bar).toHaveTextContent('VITE_STORE_MODE');
    expect(bar).toHaveTextContent(
      String.raw`Fix or remove C:\ProgramData\SupermarketPOS\client\store.env, then restart.`
    );
  });

  it('is localized in Spanish and has a reason for every blocking code', async () => {
    await i18n.changeLanguage('es-MX');
    for (const code of [
      'STORE_MODE_UNKNOWN',
      'STORE_URL_REJECTED',
      'STORE_KEY_MISSING',
      'STORE_CA_MISSING',
      'STORE_FILE_UNREADABLE',
      'SOMETHING_NEW',
    ]) {
      setStoreRuntimeConfig({ storeMode: 'cloud', storeConfigError: code });
      const { unmount } = render(<StoreConfigBanner />);
      const text = screen.getByTestId('store-config-banner').textContent ?? '';
      expect(text).toContain('store.env no es válido');
      expect(text).toContain('Corrige o elimina');
      expect(text).not.toMatch(/storeConfig\./);
      unmount();
    }
  });
});
