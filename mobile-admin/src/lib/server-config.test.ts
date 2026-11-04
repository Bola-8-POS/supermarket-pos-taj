import { loginEligible } from './auth-policy';
import { parseServerConfig } from './server-config';

// Built at runtime so no JWT-shaped literal sits in source (scripts/check-secrets.mjs).
const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fakeJwt = (role: string) => [b64({ alg: 'HS256' }), b64({ role }), 'fake'].join('.');
const ANON_KEY = fakeJwt('anon');

describe('parseServerConfig', () => {
  it('normalizes a remote HTTPS project', () => {
    expect(
      parseServerConfig({
        url: '  https://abc.supabase.co/  ',
        anonKey: `  ${ANON_KEY}  `,
      })
    ).toEqual({ url: 'https://abc.supabase.co', anonKey: ANON_KEY });
  });

  it.each([
    'http://localhost:54321',
    'http://127.0.0.1:54321',
    'http://10.0.2.2:54321',
    'http://10.2.3.4:54321',
    'http://172.16.2.3:54321',
    'http://172.31.255.254:54321',
    'http://192.168.1.153:54321',
    'http://pos.local:54321',
  ])('accepts local HTTP host %s', url => {
    expect(parseServerConfig({ url, anonKey: ANON_KEY }).url).toBe(url);
  });

  it.each(['http://example.com', 'http://172.32.0.1:54321', 'ftp://192.168.1.2'])('rejects unsafe URL %s', url => {
    expect(() => parseServerConfig({ url, anonKey: ANON_KEY })).toThrow(/HTTPS|HTTP/);
  });

  it('rejects paths and credentials in the project URL', () => {
    expect(() => parseServerConfig({ url: 'https://abc.supabase.co/rest', anonKey: ANON_KEY })).toThrow(
      'base URL'
    );
    expect(() =>
      parseServerConfig({ url: 'https://user:pass@abc.supabase.co', anonKey: ANON_KEY })
    ).toThrow('credentials');
  });

  it.each([
    ['sb_secret', 'test_key_1234567890'].join('_'),
    fakeJwt('service_role'),
  ])('rejects privileged key %s', anonKey => {
    expect(() => parseServerConfig({ url: 'https://abc.supabase.co', anonKey })).toThrow(/secret|service-role/);
  });

  it('rejects missing or malformed configuration', () => {
    expect(() => parseServerConfig({ url: 'not a URL', anonKey: ANON_KEY })).toThrow('valid Supabase URL');
    expect(() => parseServerConfig({ url: 'https://abc.supabase.co', anonKey: 'short' })).toThrow(
      'legacy anon key'
    );
  });
});

describe('parseServerConfig publishable keys', () => {
  it('rejects a publishable key because staff-sign-in needs a JWT', () => {
    expect(() => parseServerConfig({ url: 'https://abc.supabase.co', anonKey: ['sb_publishable', 'abcdefghij1234567890'].join('_') })).toThrow(
      "This app needs the project's legacy anon key (starts with eyJ). Publishable keys can't sign in yet."
    );
  });

  it('still accepts a legacy anon JWT', () => {
    const anonKey = fakeJwt('anon');
    expect(parseServerConfig({ url: 'https://abc.supabase.co', anonKey }).anonKey).toBe(anonKey);
  });
});

describe('loginEligible', () => {
  it('allows only active managers and admins', () => {
    expect(loginEligible({ is_active: true, role: 'manager' })).toBe(true);
    expect(loginEligible({ is_active: true, role: 'admin' })).toBe(true);
    expect(loginEligible({ is_active: true, role: 'cashier' })).toBe(false);
    expect(loginEligible({ is_active: false, role: 'manager' })).toBe(false);
    expect(loginEligible({ is_active: false, role: 'admin' })).toBe(false);
  });
});
